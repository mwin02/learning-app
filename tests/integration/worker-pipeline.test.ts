// DB integration tests for F3: the course-worker pipeline branch logic. The four
// expensive stages (ensureMap / remediate / build / backfillBanks) and the Program
// assembler hook are injected as stubs — same `opts` pattern as enqueueProgram's
// `plan` — so we exercise every branch of processCourseRequest without an LLM. The
// real finishCourseRequest write is what we assert against, so each test seeds a
// `running` CourseRequest and reads the row back.
//
// Self-cleaning: throwaway rows use a __verify_pipe__ marker, deleted in before/after.
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { PathStatus, TrackStatus, CourseRequestStatus } from '@prisma/client';
import type { CourseRequest } from '@prisma/client';
import { prisma } from '@/lib/db';
import { processCourseRequest } from '@/lib/services/course-worker';
import type { EnsurePathMapResult } from '@/lib/agents/map/ensure-path-map';
import type { RemediateResult } from '@/lib/agents/track/remediate-path';
import type { BuildTrackResult } from '@/lib/agents/track/build-track';
import type { BackfillConceptBanksResult } from '@/lib/agents/content/generate-concept-bank';
import { describeDb } from './db';

const MARK = '__verify_pipe__';

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } }); // cascades child CourseRequests
  await prisma.courseRequest.deleteMany({ where: { topic: { startsWith: MARK } } });
  await prisma.track.deleteMany({ where: { path: { topic: { startsWith: MARK } } } });
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

// Seed a `running` CourseRequest — the state finishCourseRequest's guard requires.
function seedRunning(suffix: string, over: Partial<{ programId: string }> = {}): Promise<CourseRequest> {
  return prisma.courseRequest.create({
    data: {
      topic: `${MARK}${suffix}`,
      status: CourseRequestStatus.running,
      claimedAt: new Date(),
      programId: over.programId ?? null,
    },
  });
}

// A real Path + Track so a stubbed build can return a genuine (FK-valid) trackId.
async function makeTrack(suffix: string): Promise<string> {
  const path = await prisma.path.create({ data: { topic: `${MARK}${suffix}` }, select: { id: true } });
  const track = await prisma.track.create({
    data: { pathId: path.id, status: TrackStatus.ready, title: `Track ${suffix}` },
    select: { id: true },
  });
  return track.id;
}

const makeProgram = (suffix: string) =>
  prisma.program.create({
    data: { goal: `${MARK} ${suffix}`, totalHoursPerWeek: 4, totalWeeks: 8 },
    select: { id: true },
  });

const getReq = (id: string) =>
  prisma.courseRequest.findUniqueOrThrow({ where: { id }, select: { status: true, error: true, trackId: true } });

// --- stage stubs (typed against the real result shapes) ---
const ensureMapStub =
  (status: PathStatus): (() => Promise<EnsurePathMapResult>) =>
  async () => ({ pathId: `${MARK}path`, status, created: true, reclaimed: false, holes: [] });

const remResult = (outcome: RemediateResult['outcome'], status: PathStatus): RemediateResult => ({
  outcome,
  status,
  holes: [],
  relaxedConceptSlugs: [],
  escalatedConceptSlugs: [],
});

const buildResult = (trackId: string): BuildTrackResult => ({
  trackId,
  status: TrackStatus.ready,
  lessonCount: 3,
  budgetWeak: false,
  depthConstrained: false,
  underResourced: [],
  warnings: [],
});

const bankResult = (): BackfillConceptBanksResult => ({
  candidates: 0,
  generated: 0,
  empty: 0,
  failed: 0,
  questions: 0,
});

describeDb('course-worker pipeline branches', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('remediation `busy` → failed with a retryable diagnostic', async () => {
    const cr = await seedRunning('busy');
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.building),
      remediate: async () => remResult('busy', PathStatus.building),
    });
    expect(outcome).toBe('failed');
    const row = await getReq(cr.id);
    expect(row.status).toBe(CourseRequestStatus.failed);
    expect(row.error).toContain('remediation busy');
  });

  it('still `building` after remediation → failed (not spine_ready)', async () => {
    const cr = await seedRunning('holey');
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.building),
      // Remediation ran but couldn't close every hole: status stays `building`.
      remediate: async () => remResult('escalated', PathStatus.building),
    });
    expect(outcome).toBe('failed');
    const row = await getReq(cr.id);
    expect(row.status).toBe(CourseRequestStatus.failed);
    expect(row.error).toContain('did not reach spine_ready');
  });

  it('spine_ready → fulfilled + trackId linked', async () => {
    const trackId = await makeTrack('ok');
    const cr = await seedRunning('ok');
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready), // no remediation needed
      backfillBanks: async () => bankResult(),
      build: async () => buildResult(trackId),
    });
    expect(outcome).toBe('fulfilled');
    const row = await getReq(cr.id);
    expect(row.status).toBe(CourseRequestStatus.fulfilled);
    expect(row.trackId).toBe(trackId);
  });

  it('fires the Program assembler hook for a child request', async () => {
    const program = await makeProgram('hook');
    const trackId = await makeTrack('hook');
    const cr = await seedRunning('hook', { programId: program.id });
    let hookArg: string | null = null;
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      build: async () => buildResult(trackId),
      assembleProgram: async (pid) => {
        hookArg = pid;
      },
    });
    expect(outcome).toBe('fulfilled');
    expect(hookArg).toBe(program.id);
  });

  it('a throwing assembler hook is non-fatal', async () => {
    const program = await makeProgram('hookfail');
    const trackId = await makeTrack('hookfail');
    const cr = await seedRunning('hookfail', { programId: program.id });
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      build: async () => buildResult(trackId),
      assembleProgram: async () => {
        throw new Error('hook boom');
      },
    });
    // The request was already fulfilled; the hook failure must not change that.
    expect(outcome).toBe('fulfilled');
    expect((await getReq(cr.id)).status).toBe(CourseRequestStatus.fulfilled);
  });

  it('a throwing concept-bank backfill is non-fatal', async () => {
    const trackId = await makeTrack('bank');
    const cr = await seedRunning('bank');
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => {
        throw new Error('bank boom');
      },
      build: async () => buildResult(trackId),
    });
    // Backfill is best-effort: the pipeline continues to build → fulfilled.
    expect(outcome).toBe('fulfilled');
    expect((await getReq(cr.id)).status).toBe(CourseRequestStatus.fulfilled);
  });
});
