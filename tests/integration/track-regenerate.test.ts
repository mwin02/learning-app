// DB integration tests for Reports R5 (track regeneration). Real DB, NO LLM — a
// rebuild is preconditions plus one CourseRequest insert, and the "build" is
// simulated by fulfilling that request with a second Track, exactly as the worker
// would. Self-cleaning via the __verify_regen__ marker. Skips cleanly without
// DATABASE_URL (describeDb).
//
// What this file exists to guard: regeneration adds NO build machinery, so the whole
// feature rests on maybeAssembleProgram already repointing ProgramPath.trackId on
// (programId, topic) and no-opping its status guard on a `ready` Program. That is
// behaviour of code this block did not write, which makes it exactly the behaviour a
// future refactor can take away without noticing.
//
// Run with the workers stopped — this file leaves a `queued` CourseRequest between
// its own steps, and anything scanning the whole queue will claim it (see
// .claude/rules/testing.md).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { CourseRequestStatus, ProgramStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { maybeAssembleProgram } from '@/lib/services/program';
import { regenerateTrack } from '@/lib/services/regenerate-track';
import { FREE_TRACK_REBUILDS_PER_MONTH } from '@/lib/config';
import { describeDb } from './db';

const MARK = '__verify_regen__';

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } }); // cascades ProgramPath + CourseRequest
  // Tracks (→ Lessons → LessonResources) before Resources: LessonResource.resource
  // has no onDelete, so a still-referenced Resource refuses to delete.
  await prisma.track.deleteMany({ where: { path: { topic: { startsWith: MARK } } } });
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
  // startsWith, not an exact id: every test gets its own user (see seedSlot).
  await prisma.user.deleteMany({ where: { id: { startsWith: MARK } } });
}

type Slot = {
  userId: string;
  programId: string;
  topic: string;
  trackId: string;
  resourceId: string;
  oldRequestId: string;
};

// A `ready` Program with one built Track in its single slot, the fulfilled
// CourseRequest that produced it, and the caller enrolled — i.e. the state a learner
// is actually in when they press "rebuild".
//
// `stale` seeds the reason to rebuild: a resource deprecated AFTER the Track was
// built (the dead-link report loop). Left false, nothing has moved since the build
// and precondition 4 must refuse.
//
// Each call gets its OWN user, which is load-bearing rather than tidiness: the
// rebuild quota is per user per calendar month across ALL programs, so a shared user
// would let each test spend the next one's quota. On a shared user this file was
// order-dependent — the sixth test opened already at FREE_TRACK_REBUILDS_PER_MONTH
// and refused `quota_exceeded` before reaching what it tested, and adding a test
// anywhere above would have broken a different one.
async function seedSlot(suffix: string, opts: { stale: boolean }): Promise<Slot> {
  const topic = `${MARK}${suffix}`;
  const userId = `${MARK}user-${suffix}`;
  await prisma.user.create({ data: { id: userId, email: `${MARK}${suffix}@example.test` } });
  const source = await prisma.source.create({
    data: { slug: `${MARK}${suffix}-src`, name: 'src', url: 'https://example.invalid', kind: 'community' },
  });
  const resource = await prisma.resource.create({
    data: {
      slug: `${MARK}${suffix}-res`,
      topic,
      title: 'Res',
      url: `https://example.invalid/${suffix}`,
      type: 'article',
      durationMin: 30,
      summary: 's',
      difficulty: 'beginner',
      sourceId: source.id,
    },
  });
  const path = await prisma.path.create({ data: { topic, status: 'spine_ready' } });

  // Created LAST so every fixture timestamp above precedes track.createdAt — the
  // staleness predicate compares against it, and a fixture written afterwards would
  // read as "changed since the build" and silently defeat the not-stale case.
  const track = await prisma.track.create({
    data: {
      pathId: path.id,
      status: 'ready',
      title: `Track ${suffix}`,
      priorKnowledge: 'some python',
      goal: 'learn pandas',
      timeframeWeeks: 8,
      hoursPerWeek: 5,
      targetMastery: 'intermediate',
    },
  });
  const lesson = await prisma.lesson.create({
    data: {
      trackId: track.id,
      orderInTrack: 1,
      title: 'L1',
      summary: 's',
      conceptsTaught: ['c1'],
      estMinutes: 30,
    },
  });
  await prisma.lessonResource.create({
    data: { lessonId: lesson.id, resourceId: resource.id, deliveryMode: 'newtab' },
  });

  if (opts.stale) {
    await prisma.resource.update({
      where: { id: resource.id },
      data: { status: 'deprecated', deprecationSeverity: 'hard' },
    });
  }

  const program = await prisma.program.create({
    data: {
      goal: `${MARK} ${suffix}`,
      totalHoursPerWeek: 5,
      totalWeeks: 8,
      status: ProgramStatus.ready,
      userId,
      enrollments: { create: { userId } },
      programPaths: {
        create: {
          topic,
          trackId: track.id,
          phaseLabel: 'Phase 1',
          orderInProgram: 1,
          priorityTier: 'core',
        },
      },
    },
    select: { id: true },
  });
  const oldRequest = await prisma.courseRequest.create({
    data: {
      topic,
      programId: program.id,
      userId,
      status: CourseRequestStatus.fulfilled,
      trackId: track.id,
      // Explicit and comfortably earlier than the rebuild's, so createdAt ordering
      // between the two siblings is never a same-millisecond coin flip.
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    },
    select: { id: true },
  });

  return {
    userId,
    programId: program.id,
    topic,
    trackId: track.id,
    resourceId: resource.id,
    oldRequestId: oldRequest.id,
  };
}

// Stand-in for the worker's successful build of the rebuild request.
async function fulfillWith(requestId: string, pathId: string, title: string): Promise<string> {
  const track = await prisma.track.create({ data: { pathId, status: 'ready', title }, select: { id: true } });
  await prisma.courseRequest.update({
    where: { id: requestId },
    data: { status: CourseRequestStatus.fulfilled, trackId: track.id },
  });
  return track.id;
}

const slotTrackId = async (programId: string, topic: string) =>
  (await prisma.programPath.findFirstOrThrow({ where: { programId, topic }, select: { trackId: true } })).trackId;
const programStatus = async (programId: string) =>
  (await prisma.program.findUniqueOrThrow({ where: { id: programId }, select: { status: true } })).status;
const pathIdOf = async (trackId: string) =>
  (await prisma.track.findUniqueOrThrow({ where: { id: trackId }, select: { pathId: true } })).pathId;

describeDb('track regeneration (R5)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('enqueues a rebuild, and the assembler repoints the slot while leaving a ready Program ready', async () => {
    const slot = await seedSlot('happy', { stale: true });

    const result = await regenerateTrack({
      userId: slot.userId,
      programId: slot.programId,
      trackId: slot.trackId,
    });
    expect(result).toMatchObject({ ok: true, topic: slot.topic, deduplicated: false });
    if (!result.ok) return; // narrowing; the assertion above already failed

    // The request is a sibling of the same (programId, topic) — which is the whole
    // reason the unchanged assembler can repoint the slot — carrying the marker and
    // the old Track's inputs.
    const req = await prisma.courseRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(req.programId).toBe(slot.programId);
    expect(req.topic).toBe(slot.topic);
    expect(req.replacesTrackId).toBe(slot.trackId);
    expect(req.status).toBe(CourseRequestStatus.queued);
    expect(req).toMatchObject({
      priorKnowledge: 'some python',
      goal: 'learn pandas',
      timeframeWeeks: 8,
      hoursPerWeek: 5,
      targetMastery: 'intermediate',
    });

    // Still pointing at the old Track while the rebuild is in flight, and the
    // assembler is a no-op with a non-terminal sibling.
    await maybeAssembleProgram(slot.programId);
    expect(await slotTrackId(slot.programId, slot.topic)).toBe(slot.trackId);

    const newTrackId = await fulfillWith(result.requestId, await pathIdOf(slot.trackId), 'Rebuilt');
    await maybeAssembleProgram(slot.programId);

    expect(await slotTrackId(slot.programId, slot.topic)).toBe(newTrackId);
    expect(await programStatus(slot.programId)).toBe(ProgramStatus.ready);
    // The old Track is evidence for why the rebuild happened — never deleted (R6).
    expect(await prisma.track.count({ where: { id: slot.trackId } })).toBe(1);
  });

  // Guards the `orderBy: { createdAt: 'asc' }` on maybeAssembleProgram's sibling
  // query. A rebuild makes two FULFILLED siblings share one topic, and the repoint
  // applies their updateMany calls in array order — so without an ORDER BY the
  // winner is whatever order Postgres returns and the rebuild can be silently
  // overwritten by the Track it replaced.
  //
  // Postgres does not contractually guarantee seq-scan order, so this test PROVOKES
  // the regression rather than proving it in the abstract: touching the old request
  // last rewrites its tuple, which in practice lands it at the end of the heap and
  // therefore last in an unordered scan. With the orderBy present the physical order
  // is irrelevant and this passes; without it, this seeding is what makes it fail
  // instead of flaking. The property under test is precisely that the outcome does
  // not depend on physical row order.
  it('repoints to the NEWEST fulfilled sibling regardless of physical row order', async () => {
    const slot = await seedSlot('order', { stale: true });
    const result = await regenerateTrack({
      userId: slot.userId,
      programId: slot.programId,
      trackId: slot.trackId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newTrackId = await fulfillWith(result.requestId, await pathIdOf(slot.trackId), 'Rebuilt-order');

    // A later write to the OLD request — legitimate on its own (a usage backfill, a
    // worker finishing siblings out of order) and must not change which Track wins.
    await prisma.courseRequest.update({
      where: { id: slot.oldRequestId },
      data: { claimedBy: 'touched-last' },
    });

    await maybeAssembleProgram(slot.programId);
    expect(await slotTrackId(slot.programId, slot.topic)).toBe(newTrackId);
  });

  it('leaves the old trackId in place when the rebuild fails', async () => {
    const slot = await seedSlot('failed', { stale: true });
    const result = await regenerateTrack({
      userId: slot.userId,
      programId: slot.programId,
      trackId: slot.trackId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await prisma.courseRequest.update({
      where: { id: result.requestId },
      data: { status: CourseRequestStatus.failed, error: 'boom' },
    });
    await maybeAssembleProgram(slot.programId);

    expect(await slotTrackId(slot.programId, slot.topic)).toBe(slot.trackId);
    // The old sibling is still fulfilled, so the Program is not dragged to `partial`
    // — and the status guard no-ops on `ready` regardless.
    expect(await programStatus(slot.programId)).toBe(ProgramStatus.ready);
  });

  it('refuses a rebuild when nothing has changed since the build', async () => {
    const slot = await seedSlot('fresh', { stale: false });
    const result = await regenerateTrack({
      userId: slot.userId,
      programId: slot.programId,
      trackId: slot.trackId,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'not_stale' });
    expect(
      await prisma.courseRequest.count({
        where: { programId: slot.programId, replacesTrackId: { not: null } },
      }),
    ).toBe(0);

    // …and accepts it once a resource in the Track is deprecated — the loop reports
    // exist to close.
    await prisma.resource.update({
      where: { id: slot.resourceId },
      data: { status: 'deprecated', deprecationSeverity: 'hard' },
    });
    const retry = await regenerateTrack({
      userId: slot.userId,
      programId: slot.programId,
      trackId: slot.trackId,
    });
    expect(retry.ok).toBe(true);
  });

  it('refuses a caller who is not enrolled in the program', async () => {
    const slot = await seedSlot('unenrolled', { stale: true });
    await prisma.enrolledProgram.delete({
      where: { userId_programId: { userId: slot.userId, programId: slot.programId } },
    });
    expect(
      await regenerateTrack({ userId: slot.userId, programId: slot.programId, trackId: slot.trackId }),
    ).toEqual({ ok: false, refusal: 'not_enrolled' });
  });

  it('refuses while a rebuild is already in flight for the slot', async () => {
    const slot = await seedSlot('inflight', { stale: true });
    const first = await regenerateTrack({
      userId: slot.userId,
      programId: slot.programId,
      trackId: slot.trackId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The caller's own in-flight rebuild dedups to a 202 carrying the same request.
    const second = await regenerateTrack({
      userId: slot.userId,
      programId: slot.programId,
      trackId: slot.trackId,
    });
    expect(second).toMatchObject({ ok: true, requestId: first.requestId, deduplicated: true });

    // Someone else's in-flight rebuild of the same slot refuses by name.
    const otherId = `${MARK}other`;
    await prisma.user.create({ data: { id: otherId, email: `${MARK}other@example.test` } });
    await prisma.enrolledProgram.create({ data: { userId: otherId, programId: slot.programId } });
    expect(
      await regenerateTrack({ userId: otherId, programId: slot.programId, trackId: slot.trackId }),
    ).toEqual({ ok: false, refusal: 'already_rebuilding' });
    await prisma.user.delete({ where: { id: otherId } });

    expect(
      await prisma.courseRequest.count({
        where: { programId: slot.programId, replacesTrackId: { not: null } },
      }),
    ).toBe(1);
  });

  // The quota is the refusal that costs money to get wrong, and it is the one this
  // file's own fixture tripped over — it counts per user per calendar month across
  // every program, not per slot. Banked directly rather than by calling
  // regenerateTrack N times, because the single-in-flight precondition would refuse
  // the second call on the same slot: what needs exercising here is rebuildQuota's
  // counting against real rows, not the ladder above it.
  it('refuses once the monthly rebuild quota is spent, and excludes failed rebuilds', async () => {
    const slot = await seedSlot('quota', { stale: true });
    await prisma.courseRequest.createMany({
      data: Array.from({ length: FREE_TRACK_REBUILDS_PER_MONTH }, () => ({
        topic: slot.topic,
        programId: slot.programId,
        userId: slot.userId,
        replacesTrackId: slot.trackId,
        status: CourseRequestStatus.fulfilled,
      })),
    });
    // A failed rebuild must not burn quota — same rule as the program quota. If this
    // were counted, `used` below would exceed the limit and the assertion would say so.
    await prisma.courseRequest.create({
      data: {
        topic: slot.topic,
        programId: slot.programId,
        userId: slot.userId,
        replacesTrackId: slot.trackId,
        status: CourseRequestStatus.failed,
        error: 'boom',
      },
    });

    expect(
      await regenerateTrack({
        userId: slot.userId,
        programId: slot.programId,
        trackId: slot.trackId,
      }),
    ).toEqual({
      ok: false,
      refusal: 'quota_exceeded',
      quota: { used: FREE_TRACK_REBUILDS_PER_MONTH, limit: FREE_TRACK_REBUILDS_PER_MONTH },
    });

    // Nothing was enqueued: the banked rows plus the failed one, and no more.
    expect(
      await prisma.courseRequest.count({
        where: { userId: slot.userId, replacesTrackId: { not: null } },
      }),
    ).toBe(FREE_TRACK_REBUILDS_PER_MONTH + 1);
  });
});
