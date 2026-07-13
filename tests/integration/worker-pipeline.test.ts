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
import { finishCourseRequest } from '@/lib/services/course-request';
import { COURSE_CONTENTION_REQUEUE_MS, COURSE_REQUEST_MAX_ATTEMPTS, MAX_FRONTIER_PER_TOPIC } from '@/lib/config';
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
function seedRunning(
  suffix: string,
  over: Partial<{ programId: string; frontierConcepts: string[] }> = {},
): Promise<CourseRequest> {
  return prisma.courseRequest.create({
    data: {
      topic: `${MARK}${suffix}`,
      status: CourseRequestStatus.running,
      claimedAt: new Date(),
      programId: over.programId ?? null,
      frontierConcepts: over.frontierConcepts ?? [],
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
  (status: PathStatus, inFlight = false): (() => Promise<EnsurePathMapResult>) =>
  async () => ({ pathId: `${MARK}path`, status, created: true, reclaimed: false, inFlight, holes: [] });

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
  fillRatio: null,
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

  // --- Workers-A2: same-topic contention → requeue with backoff (D2) ---------

  it('remediation `busy` → requeued with backoff (expected contention under N workers)', async () => {
    const cr = await seedRunning('busy');
    const before = Date.now();
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.building),
      remediate: async () => remResult('busy', PathStatus.building),
    });
    expect(outcome).toBe('requeued');
    const row = await prisma.courseRequest.findUniqueOrThrow({ where: { id: cr.id } });
    expect(row.status).toBe(CourseRequestStatus.queued); // back in the queue, not failed
    expect(row.error).toBeNull();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + COURSE_CONTENTION_REQUEUE_MS);
  });

  it('an in-flight sibling build (map.inFlight) → requeued; remediate/build/hook never run', async () => {
    const program = await makeProgram('inflight');
    const cr = await seedRunning('inflight', { programId: program.id });
    const called = { remediate: false, build: false, hook: false };
    const before = Date.now();
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.building, /* inFlight */ true),
      remediate: async () => {
        called.remediate = true;
        return remResult('succeeded', PathStatus.spine_ready);
      },
      build: async () => {
        called.build = true;
        return buildResult('never');
      },
      assembleProgram: async () => {
        called.hook = true;
      },
    });
    expect(outcome).toBe('requeued');
    // Contention short-circuits the pipeline: no remediation-slot steal, no Track
    // on a not-ready Path — and a requeued child is NOT terminal, so the Program
    // assembler must not have been consulted.
    expect(called).toEqual({ remediate: false, build: false, hook: false });
    const row = await prisma.courseRequest.findUniqueOrThrow({ where: { id: cr.id } });
    expect(row.status).toBe(CourseRequestStatus.queued);
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + COURSE_CONTENTION_REQUEUE_MS);
  });

  it('contention at the attempts cap → terminal failed (and the hook DOES fire)', async () => {
    const program = await makeProgram('inflight-cap');
    const cr = await prisma.courseRequest.create({
      data: {
        topic: `${MARK}inflight-cap`,
        status: CourseRequestStatus.running,
        claimedAt: new Date(),
        programId: program.id,
        attempts: COURSE_REQUEST_MAX_ATTEMPTS,
      },
    });
    let hookFired = false;
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.building, true),
      assembleProgram: async () => {
        hookFired = true;
      },
    });
    expect(outcome).toBe('failed');
    expect(hookFired).toBe(true); // failed IS terminal — it must count toward assembly
    const row = await getReq(cr.id);
    expect(row.status).toBe(CourseRequestStatus.failed);
    expect(row.error).toContain('max attempts');
  });

  // --- Workers-A2: graceful shutdown → release, not fail (D7) ----------------

  it('a shutdown abort mid-pipeline → requeued immediately claimable, not failed', async () => {
    const cr = await seedRunning('shutdown');
    const shutdown = new AbortController();
    const outcome = await processCourseRequest(cr, {
      // The stage observes the per-job signal (as the real stages do at their
      // checkpoints) after the shutdown fires mid-flight.
      ensureMap: async (args) => {
        shutdown.abort(new Error('SIGTERM shutdown'));
        args.abortSignal?.throwIfAborted(); // the propagated per-job abort lands here
        throw new Error('unreachable');
      },
      shutdownSignal: shutdown.signal,
    });
    expect(outcome).toBe('requeued');
    const row = await prisma.courseRequest.findUniqueOrThrow({ where: { id: cr.id } });
    expect(row.status).toBe(CourseRequestStatus.queued); // released, not failed
    expect(row.error).toBeNull();
    // delayMs 0: a surviving worker's next poll can claim it right away.
    expect(row.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('an already-aborted shutdown signal releases the claim before any stage work', async () => {
    const cr = await seedRunning('shutdown-early');
    const shutdown = new AbortController();
    shutdown.abort(new Error('SIGTERM shutdown'));
    let stageRan = false;
    const outcome = await processCourseRequest(cr, {
      ensureMap: async (args) => {
        stageRan = true;
        args.abortSignal?.throwIfAborted();
        throw new Error('unreachable');
      },
      shutdownSignal: shutdown.signal,
    });
    expect(outcome).toBe('requeued');
    expect(stageRan).toBe(true); // the stage is entered but its first checkpoint throws
    expect((await prisma.courseRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe(
      CourseRequestStatus.queued,
    );
  });

  it('shutdown during a HUNG stage → the deadline path releases (requeue), not fails', async () => {
    const cr = await seedRunning('shutdown-hung');
    const shutdown = new AbortController();
    const outcome = await processCourseRequest(cr, {
      // A stage that never observes any signal: only the deadline can unstick the
      // race, and with shutdown aborted it must requeue rather than fail.
      ensureMap: () => {
        shutdown.abort(new Error('SIGTERM shutdown'));
        return new Promise(() => {});
      },
      shutdownSignal: shutdown.signal,
      deadlineMs: 100,
    });
    expect(outcome).toBe('requeued');
    const row = await prisma.courseRequest.findUniqueOrThrow({ where: { id: cr.id } });
    expect(row.status).toBe(CourseRequestStatus.queued);
    expect(row.error).toBeNull();
  });

  it('a deadline abort (no shutdown) still fails — the two aborts stay distinguishable', async () => {
    const cr = await seedRunning('deadline-vs-shutdown');
    const shutdown = new AbortController(); // present but never aborted
    const outcome = await processCourseRequest(cr, {
      ensureMap: () => new Promise(() => {}), // hang → deadline fires
      shutdownSignal: shutdown.signal,
      deadlineMs: 100,
    });
    expect(outcome).toBe('failed');
    const row = await getReq(cr.id);
    expect(row.status).toBe(CourseRequestStatus.failed);
    expect(row.error).toContain('deadline exceeded');
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

  it('executes each recorded frontier request against the map Path, before build', async () => {
    const trackId = await makeTrack('frontier');
    const cr = await seedRunning('frontier', { frontierConcepts: ['reinforcement learning', 'gradient boosting'] });
    const calls: Array<{ pathId: string; request: string }> = [];
    let builtAfterFrontier = false;
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      addFrontier: async (args) => {
        calls.push({ pathId: args.pathId, request: args.request }); // args also carries the H4 abortSignal
        return { outcome: 'created', conceptSlug: args.request.replace(/\s+/g, '-'), resourced: true };
      },
      build: async () => {
        builtAfterFrontier = calls.length === 2;
        return buildResult(trackId);
      },
    });
    expect(outcome).toBe('fulfilled');
    expect(calls).toEqual([
      { pathId: `${MARK}path`, request: 'reinforcement learning' },
      { pathId: `${MARK}path`, request: 'gradient boosting' },
    ]);
    // The build snapshots the map's concepts, so frontier must land first.
    expect(builtAfterFrontier).toBe(true);
  });

  it('a throwing frontier request is non-fatal and does not skip the rest', async () => {
    const trackId = await makeTrack('frontierfail');
    const cr = await seedRunning('frontierfail', { frontierConcepts: ['bad one', 'good one'] });
    const seen: string[] = [];
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      addFrontier: async ({ request }) => {
        seen.push(request);
        if (request === 'bad one') throw new Error('frontier boom');
        return { outcome: 'exists', conceptSlug: 'good-one' };
      },
      build: async () => buildResult(trackId),
    });
    expect(outcome).toBe('fulfilled');
    expect(seen).toEqual(['bad one', 'good one']);
    expect((await getReq(cr.id)).status).toBe(CourseRequestStatus.fulfilled);
  });

  it('caps frontier execution at MAX_FRONTIER_PER_TOPIC and skips it entirely when empty', async () => {
    const trackId = await makeTrack('frontiercap');
    const overCap = Array.from({ length: MAX_FRONTIER_PER_TOPIC + 1 }, (_, i) => `concept ${i}`);
    const cr = await seedRunning('frontiercap', { frontierConcepts: overCap });
    let calls = 0;
    const addFrontier = async () => {
      calls += 1;
      return { outcome: 'declined', reason: 'stub' } as const;
    };
    await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      addFrontier,
      build: async () => buildResult(trackId),
    });
    expect(calls).toBe(MAX_FRONTIER_PER_TOPIC);

    // And the default (empty) column never invokes the hook at all.
    const trackId2 = await makeTrack('frontiernone');
    const cr2 = await seedRunning('frontiernone');
    calls = 0;
    const outcome = await processCourseRequest(cr2, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      addFrontier,
      build: async () => buildResult(trackId2),
    });
    expect(outcome).toBe('fulfilled');
    expect(calls).toBe(0);
  });

  // --- H4: per-job deadline ------------------------------------------------

  it('a hung stage hits the deadline: request → failed, worker resumes', async () => {
    const cr = await seedRunning('hung');
    const outcome = await processCourseRequest(cr, {
      // The hang the deadline exists for: a stage that never resolves.
      ensureMap: () => new Promise(() => {}),
      deadlineMs: 100,
    });
    // The race resolved (the loop would tick again) and the row is terminal.
    expect(outcome).toBe('failed');
    const row = await getReq(cr.id);
    expect(row.status).toBe(CourseRequestStatus.failed);
    expect(row.error).toContain('deadline exceeded');

    // The zombie pipeline finishing late must not resurrect the row.
    const trackId = await makeTrack('hung-late');
    const { finished } = await finishCourseRequest(cr.id, { status: 'fulfilled', trackId });
    expect(finished).toBe(false);
    expect((await getReq(cr.id)).status).toBe(CourseRequestStatus.failed);
  });

  it('the deadline aborts the signal threaded into the stages', async () => {
    const cr = await seedRunning('abort');
    let signalAtBuild: AbortSignal | undefined;
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      build: (input) => {
        signalAtBuild = input.abortSignal;
        return new Promise(() => {}); // hang inside the stage
      },
      deadlineMs: 100,
    });
    expect(outcome).toBe('failed');
    expect(signalAtBuild).toBeDefined();
    expect(signalAtBuild!.aborted).toBe(true);
  });

  it('a fast pipeline is unaffected by the deadline', async () => {
    const trackId = await makeTrack('fast');
    const cr = await seedRunning('fast');
    const outcome = await processCourseRequest(cr, {
      ensureMap: ensureMapStub(PathStatus.spine_ready),
      backfillBanks: async () => bankResult(),
      build: async () => buildResult(trackId),
      deadlineMs: 5_000,
    });
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
