// DB integration tests for Phase 2.75c (fan-out + assembler). Real DB, NO LLM
// (enqueueProgram's plan is stubbed). Self-cleaning: throwaway rows are marked with
// __verify_prog__ and deleted in before/after hooks. Migrated from
// scripts/verify-program-fanout.ts (R3).
//
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { ProgramStatus, CourseRequestStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { enqueueProgram, maybeAssembleProgram } from '@/lib/services/program';
import type { ProgramPlan } from '@/lib/agents/program/plan';
import { describeDb } from './db';

const MARK = '__verify_prog__';

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } }); // cascades ProgramPath + CourseRequest
  await prisma.track.deleteMany({ where: { path: { topic: { startsWith: MARK } } } });
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

// Build a stub plan for the given canonical topic keys.
const stubPlan =
  (keys: string[]): ((i: unknown) => Promise<ProgramPlan>) =>
  async () => ({
    topics: keys.map((key, i) => ({
      key,
      hoursPerWeek: 2,
      timeframeWeeks: 8,
      phaseLabel: `Phase ${i + 1}`,
      orderInProgram: i + 1,
      priorityTier: i === 0 ? ('core' as const) : ('nice_to_have' as const),
      weight: 1,
      rationale: `why ${key}`,
    })),
    droppedByGate: [],
    droppedByBudget: [],
  });

// A throwaway built Track (needs a Path) to stand in for a fulfilled child.
async function makeTrack(topic: string): Promise<string> {
  const path = await prisma.path.create({ data: { topic: `${MARK}${topic}` }, select: { id: true } });
  const track = await prisma.track.create({
    data: { pathId: path.id, status: 'ready', title: `Track for ${topic}` },
    select: { id: true },
  });
  return track.id;
}

const siblings = (programId: string) =>
  prisma.courseRequest.findMany({ where: { programId }, orderBy: { topic: 'asc' } });
const programStatus = async (programId: string) =>
  (await prisma.program.findUniqueOrThrow({ where: { id: programId }, select: { status: true } })).status;

describeDb('program fan-out + assembly', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  const kA = `${MARK}alpha`;
  const kB = `${MARK}beta`;

  it('enqueueProgram fans a plan out to building + slots + child requests', async () => {
    const enq = await enqueueProgram(
      { goal: `${MARK} goal`, background: 'bg', totalHoursPerWeek: 4, totalWeeks: 8 },
      { plan: stubPlan([kA, kB]) },
    );
    expect(enq.status).toBe(ProgramStatus.building);
    expect(enq.topicCount).toBe(2);
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.building);

    const paths = await prisma.programPath.findMany({
      where: { programId: enq.programId },
      orderBy: { orderInProgram: 'asc' },
    });
    expect(paths.length).toBe(2);
    expect(paths.every((p) => p.trackId === null)).toBe(true);

    const reqs = await siblings(enq.programId);
    expect(reqs.length).toBe(2);
    expect(
      reqs.every(
        (r) =>
          r.status === 'queued' &&
          r.programId === enq.programId &&
          r.hoursPerWeek === 2 &&
          r.timeframeWeeks === 8,
      ),
    ).toBe(true);
    expect(reqs[0].goal).toBe(`why ${reqs[0].topic}`); // child goal = per-topic rationale

    // maybeAssembleProgram is a no-op while a sibling is non-terminal.
    await maybeAssembleProgram(enq.programId);
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.building);

    // Mixed (one fulfilled, one failed) → partial + trackId linked on the fulfilled slot.
    const trackA = await makeTrack('alpha');
    await prisma.courseRequest.update({ where: { id: reqs[0].id }, data: { status: CourseRequestStatus.fulfilled, trackId: trackA } });
    await prisma.courseRequest.update({ where: { id: reqs[1].id }, data: { status: CourseRequestStatus.failed, error: 'boom' } });
    await maybeAssembleProgram(enq.programId);
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.partial);

    const slotA = await prisma.programPath.findFirstOrThrow({ where: { programId: enq.programId, topic: reqs[0].topic } });
    const slotB = await prisma.programPath.findFirstOrThrow({ where: { programId: enq.programId, topic: reqs[1].topic } });
    expect(slotA.trackId).toBe(trackA);
    expect(slotB.trackId).toBeNull();

    // Idempotent: a second finalize is a no-op.
    await maybeAssembleProgram(enq.programId);
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.partial);
  });

  it('all fulfilled → ready', async () => {
    const enq = await enqueueProgram({ goal: `${MARK} goal2`, totalHoursPerWeek: 4, totalWeeks: 8 }, { plan: stubPlan([kA, kB]) });
    const reqs = await siblings(enq.programId);
    const tA = await makeTrack('alpha2');
    const tB = await makeTrack('beta2');
    await prisma.courseRequest.update({ where: { id: reqs[0].id }, data: { status: CourseRequestStatus.fulfilled, trackId: tA } });
    await prisma.courseRequest.update({ where: { id: reqs[1].id }, data: { status: CourseRequestStatus.fulfilled, trackId: tB } });
    await maybeAssembleProgram(enq.programId);
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.ready);
  });

  it('all failed → failed', async () => {
    const enq = await enqueueProgram({ goal: `${MARK} goal3`, totalHoursPerWeek: 4, totalWeeks: 8 }, { plan: stubPlan([kA, kB]) });
    await prisma.courseRequest.updateMany({ where: { programId: enq.programId }, data: { status: CourseRequestStatus.failed, error: 'x' } });
    await maybeAssembleProgram(enq.programId);
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.failed);
  });

  it('empty plan → failed with error, no child requests', async () => {
    const enq = await enqueueProgram({ goal: `${MARK} goal4`, totalHoursPerWeek: 4, totalWeeks: 8 }, {
      plan: async () => ({ topics: [], droppedByGate: [{ topic: 'cooking', reason: 'out of domain' }], droppedByBudget: [] }),
    });
    expect(enq.status).toBe(ProgramStatus.failed);
    expect(enq.topicCount).toBe(0);
    expect(enq.failureKind).toBe('plan_empty'); // well-formed request, nothing in-domain → 422 class

    const prog = await prisma.program.findUniqueOrThrow({ where: { id: enq.programId }, select: { status: true, error: true } });
    expect(prog.status).toBe(ProgramStatus.failed);
    expect(prog.error).toBeTruthy();
    expect((await siblings(enq.programId)).length).toBe(0);
  });

  it('throwing plan → failed with failureKind=internal + persisted error', async () => {
    const enq = await enqueueProgram({ goal: `${MARK} goal5`, totalHoursPerWeek: 4, totalWeeks: 8 }, {
      plan: async () => {
        throw new Error('gemini exploded');
      },
    });
    expect(enq.status).toBe(ProgramStatus.failed);
    expect(enq.topicCount).toBe(0);
    expect(enq.failureKind).toBe('internal'); // LLM/DB fault → 500 class, message not echoed to client
    expect(enq.error).toContain('gemini exploded');

    const prog = await prisma.program.findUniqueOrThrow({ where: { id: enq.programId }, select: { status: true, error: true } });
    expect(prog.status).toBe(ProgramStatus.failed);
    expect(prog.error).toContain('gemini exploded'); // persisted for audit
    expect((await siblings(enq.programId)).length).toBe(0);
  });
});
