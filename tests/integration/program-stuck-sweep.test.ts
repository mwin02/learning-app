// DB integration tests for F1: the stuck-Program sweeper (sweepStuckPrograms).
// Real DB, NO LLM (enqueueProgram's plan is stubbed). Self-cleaning: throwaway rows
// are marked with __verify_prog__ and deleted in before/after hooks.
//
// The bug: maybeAssembleProgram only runs inline after a child finishes, and a
// failure there is swallowed. So a Program can end up `building` with every child
// terminal — stranded forever. sweepStuckPrograms is the backstop that finalizes it.
//
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { ProgramStatus, CourseRequestStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { enqueueProgram, sweepStuckPrograms } from '@/lib/services/program';
import type { ProgramPlan } from '@/lib/agents/program/plan';
import { describeDb } from './db';

// Distinct per-file marker (fan-out uses __verify_prog__): the cleanup() below deletes
// by prefix, and Vitest runs integration files concurrently, so a shared marker would
// let one file's cleanup wipe the other's rows mid-run.
const MARK = '__verify_sweep__';

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } }); // cascades ProgramPath + CourseRequest
  await prisma.track.deleteMany({ where: { path: { topic: { startsWith: MARK } } } });
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

// Stub plan for the given canonical topic keys (mirrors program-fanout.test.ts).
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

// Fan a Program out to `building` with two child requests, WITHOUT running assembly —
// the stuck state we want to reproduce.
async function enqueueBuilding(goalSuffix: string) {
  const enq = await enqueueProgram(
    { goal: `${MARK} ${goalSuffix}`, totalHoursPerWeek: 4, totalWeeks: 8 },
    { plan: stubPlan([`${MARK}alpha`, `${MARK}beta`]) },
  );
  expect(enq.status).toBe(ProgramStatus.building);
  return enq;
}

describeDb('sweepStuckPrograms', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('finalizes a stuck `building` Program whose children are all terminal', async () => {
    const enq = await enqueueBuilding('stuck');
    const reqs = await siblings(enq.programId);

    // Both children reached a terminal state but the assembler never ran (the F1 bug).
    const trackA = await makeTrack('stuck-alpha');
    await prisma.courseRequest.update({
      where: { id: reqs[0].id },
      data: { status: CourseRequestStatus.fulfilled, trackId: trackA },
    });
    await prisma.courseRequest.update({
      where: { id: reqs[1].id },
      data: { status: CourseRequestStatus.failed, error: 'boom' },
    });
    // Precondition: still stranded in `building`.
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.building);

    const swept = await sweepStuckPrograms();
    expect(swept).toBeGreaterThanOrEqual(1);

    // Finalized to `partial` (one fulfilled, one failed) with the fulfilled slot linked.
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.partial);
    const slotA = await prisma.programPath.findFirstOrThrow({
      where: { programId: enq.programId, topic: reqs[0].topic },
    });
    expect(slotA.trackId).toBe(trackA);
  });

  it('leaves an in-flight Program (a child still queued/running) untouched', async () => {
    const enq = await enqueueBuilding('inflight');
    const reqs = await siblings(enq.programId);

    // One child done, the other still running — assembly must not fire.
    await prisma.courseRequest.update({
      where: { id: reqs[0].id },
      data: { status: CourseRequestStatus.failed, error: 'x' },
    });
    await prisma.courseRequest.update({
      where: { id: reqs[1].id },
      data: { status: CourseRequestStatus.running, claimedAt: new Date() },
    });

    // A sibling still running means the `none` guard excludes this Program from the
    // sweep. (Asserting the global count is 0 would be fragile — the sweep scans the
    // whole shared dev DB — so we assert this Program specifically stays building.)
    await sweepStuckPrograms();
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.building);
  });

  it('is a no-op when nothing is stuck', async () => {
    // A healthy Program that already finalized to `ready` (all children fulfilled,
    // assembler ran) — must not be re-touched or counted.
    const enq = await enqueueBuilding('healthy');
    const reqs = await siblings(enq.programId);
    const tA = await makeTrack('healthy-alpha');
    const tB = await makeTrack('healthy-beta');
    await prisma.courseRequest.update({
      where: { id: reqs[0].id },
      data: { status: CourseRequestStatus.fulfilled, trackId: tA },
    });
    await prisma.courseRequest.update({
      where: { id: reqs[1].id },
      data: { status: CourseRequestStatus.fulfilled, trackId: tB },
    });
    // Finalize it the healthy way first.
    const { maybeAssembleProgram } = await import('@/lib/services/program');
    await maybeAssembleProgram(enq.programId);
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.ready);

    // A `building` Program with ZERO children (mid fan-out) must also be left alone.
    const empty = await prisma.program.create({
      data: { goal: `${MARK} empty`, totalHoursPerWeek: 2, totalWeeks: 4, status: ProgramStatus.building },
      select: { id: true },
    });

    // Neither the already-`ready` Program nor the zero-child `building` Program is
    // stuck, so the sweep must leave both exactly as they are. (Global count is not
    // asserted — the sweep scans the shared dev DB and may finalize unrelated rows.)
    await sweepStuckPrograms();
    expect(await programStatus(enq.programId)).toBe(ProgramStatus.ready);
    expect(await programStatus(empty.id)).toBe(ProgramStatus.building); // untouched, not failed
  });
});
