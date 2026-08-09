// DB integration tests for Reports R6 (progress carry-over across a rebuild). Real
// DB, NO LLM — the "build" of the rebuild request is simulated by fulfilling it with
// a second Track, exactly as the worker would, and the assertion is on what
// maybeAssembleProgram writes when it repoints the slot. Self-cleaning via the
// __verify_carry__ marker; skips cleanly without DATABASE_URL (describeDb).
//
// What this file exists to guard: the carry-over is invisible in the product until a
// learner rebuilds a half-finished course, so a regression here looks like nothing at
// all until it looks like "the rebuild wiped my progress" — the exact failure the
// feature exists to prevent.
//
// Run with the workers stopped (see .claude/rules/testing.md) — the happy-path test
// leaves a `queued` CourseRequest between its own steps.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { CourseRequestStatus, ProgramStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { maybeAssembleProgram } from '@/lib/services/program';
import { regenerateTrack } from '@/lib/services/regenerate-track';
import { describeDb } from './db';

const MARK = '__verify_carry__';

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } }); // cascades ProgramPath + CourseRequest
  // Tracks (→ Lessons → Progress) before Resources: LessonResource.resource has no
  // onDelete, so a still-referenced Resource refuses to delete.
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
  pathId: string;
  trackId: string;
  lessons: Record<string, string>;
};

// The old lessons, by the concepts they teach. The rebuild below re-teaches the same
// material in a different SHAPE (a split and a merge), which is the whole reason the
// match is on conceptsTaught and not on title or ordinal.
const OLD_LESSONS: [string, string[]][] = [
  ['limits', ['limits', 'continuity']],
  ['derivatives', ['derivatives']],
  ['integrals', ['integrals']],
];

// A `ready` Program with one built Track in its single slot, the fulfilled
// CourseRequest that produced it, the caller enrolled, and a resource deprecated after
// the build so precondition 4 accepts a rebuild.
//
// Each call gets its OWN user, which is load-bearing rather than tidiness: the rebuild
// quota is per user per calendar month across ALL programs, so a shared user would let
// each test spend the next one's quota and make the file order-dependent (this bit R5).
async function seedSlot(suffix: string): Promise<Slot> {
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
  const track = await prisma.track.create({
    data: { pathId: path.id, status: 'ready', title: `Track ${suffix}`, goal: 'learn calculus' },
  });

  const lessons: Record<string, string> = {};
  for (const [i, [key, conceptsTaught]] of OLD_LESSONS.entries()) {
    const lesson = await prisma.lesson.create({
      data: {
        trackId: track.id,
        orderInTrack: i + 1,
        title: key,
        summary: 's',
        conceptsTaught,
        estMinutes: 30,
      },
      select: { id: true },
    });
    lessons[key] = lesson.id;
  }
  await prisma.lessonResource.create({
    data: { lessonId: lessons.limits, resourceId: resource.id, deliveryMode: 'newtab' },
  });
  // The reason to rebuild: the dead-link report loop deprecated a resource the Track
  // seats. Without it precondition 4 refuses and the test never reaches carry-over.
  await prisma.resource.update({
    where: { id: resource.id },
    data: { status: 'deprecated', deprecationSeverity: 'hard' },
  });

  const program = await prisma.program.create({
    data: {
      goal: `${MARK} ${suffix}`,
      totalHoursPerWeek: 5,
      totalWeeks: 8,
      status: ProgramStatus.ready,
      userId,
      enrollments: { create: { userId } },
      programPaths: {
        create: { topic, trackId: track.id, phaseLabel: 'Phase 1', orderInProgram: 1, priorityTier: 'core' },
      },
    },
    select: { id: true },
  });
  await prisma.courseRequest.create({
    data: {
      topic,
      programId: program.id,
      userId,
      status: CourseRequestStatus.fulfilled,
      trackId: track.id,
      // Comfortably earlier than the rebuild's, so createdAt ordering between the two
      // siblings is never a same-millisecond coin flip.
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });

  return { userId, programId: program.id, topic, pathId: path.id, trackId: track.id, lessons };
}

// Stand-in for the worker's successful build of the rebuild request. The new shape:
// `limits` SPLIT into two lessons, `derivatives` MERGED with an unseen concept
// (half-covered — carries), and `integrals` left untouched (never completed).
const NEW_LESSONS: [string, string[]][] = [
  ['limits-only', ['limits']],
  ['continuity-only', ['continuity']],
  ['derivatives-plus', ['derivatives', 'chain-rule']],
  ['integrals', ['integrals']],
  ['series', ['series', 'convergence']],
];

async function fulfillWith(requestId: string, pathId: string, suffix: string) {
  const track = await prisma.track.create({
    data: { pathId, status: 'ready', title: `Rebuilt ${suffix}` },
    select: { id: true },
  });
  const lessons: Record<string, string> = {};
  for (const [i, [key, conceptsTaught]] of NEW_LESSONS.entries()) {
    const lesson = await prisma.lesson.create({
      data: { trackId: track.id, orderInTrack: i + 1, title: key, summary: 's', conceptsTaught, estMinutes: 30 },
      select: { id: true },
    });
    lessons[key] = lesson.id;
  }
  await prisma.courseRequest.update({
    where: { id: requestId },
    data: { status: CourseRequestStatus.fulfilled, trackId: track.id },
  });
  return { trackId: track.id, lessons };
}

const completedTitles = async (userId: string, trackId: string) => {
  const rows = await prisma.progress.findMany({
    where: { userId, lesson: { trackId } },
    select: { lesson: { select: { title: true } } },
  });
  return rows.map((r) => r.lesson.title).sort();
};
const slotTrackId = async (programId: string, topic: string) =>
  (await prisma.programPath.findFirstOrThrow({ where: { programId, topic }, select: { trackId: true } })).trackId;

describeDb('progress carry-over across a rebuild (R6)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('carries completed material onto the rebuilt Track, through splits and merges', async () => {
    const slot = await seedSlot('happy');
    await prisma.progress.createMany({
      data: [{ userId: slot.userId, lessonId: slot.lessons.limits }, { userId: slot.userId, lessonId: slot.lessons.derivatives }],
    });

    const result = await regenerateTrack({ userId: slot.userId, programId: slot.programId, trackId: slot.trackId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rebuilt = await fulfillWith(result.requestId, slot.pathId, 'happy');
    await maybeAssembleProgram(slot.programId);

    // Both halves of the split carry (each is fully covered by the completed lesson),
    // the merged lesson carries at exactly half coverage, and the two lessons whose
    // material was never finished do not.
    expect(await slotTrackId(slot.programId, slot.topic)).toBe(rebuilt.trackId);
    expect(await completedTitles(slot.userId, rebuilt.trackId)).toEqual([
      'continuity-only',
      'derivatives-plus',
      'limits-only',
    ]);

    // The old Track and its progress are untouched — the evidence for why the rebuild
    // happened, and nothing here mutates a built Track.
    expect(await completedTitles(slot.userId, slot.trackId)).toEqual(['derivatives', 'limits']);
  });

  it('carries only for the learner who requested the rebuild', async () => {
    const slot = await seedSlot('peruser');
    const otherId = `${MARK}user-peruser-other`;
    await prisma.user.create({ data: { id: otherId, email: `${MARK}peruser-other@example.test` } });
    await prisma.enrolledProgram.create({ data: { userId: otherId, programId: slot.programId } });
    // The co-enrolled learner has finished MORE of the old Track — and still gets
    // nothing: only the requester's slot moved, and progress is per-user.
    await prisma.progress.createMany({
      data: OLD_LESSONS.map(([key]) => ({ userId: otherId, lessonId: slot.lessons[key] })),
    });
    await prisma.progress.create({ data: { userId: slot.userId, lessonId: slot.lessons.derivatives } });

    const result = await regenerateTrack({ userId: slot.userId, programId: slot.programId, trackId: slot.trackId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rebuilt = await fulfillWith(result.requestId, slot.pathId, 'peruser');
    await maybeAssembleProgram(slot.programId);

    expect(await completedTitles(slot.userId, rebuilt.trackId)).toEqual(['derivatives-plus']);
    expect(await completedTitles(otherId, rebuilt.trackId)).toEqual([]);
  });

  it('writes nothing for a first build (no replacesTrackId)', async () => {
    const slot = await seedSlot('firstbuild');
    await prisma.progress.create({ data: { userId: slot.userId, lessonId: slot.lessons.limits } });

    // A second topic in the same Program, built for the first time: same assembler
    // pass, no rebuild marker, so no carry-over may fire.
    const request = await prisma.courseRequest.create({
      data: { topic: `${slot.topic}-b`, programId: slot.programId, userId: slot.userId },
      select: { id: true },
    });
    await prisma.programPath.create({
      data: {
        programId: slot.programId,
        topic: `${slot.topic}-b`,
        phaseLabel: 'Phase 2',
        orderInProgram: 2,
        priorityTier: 'core',
      },
    });
    const built = await fulfillWith(request.id, slot.pathId, 'firstbuild');
    await maybeAssembleProgram(slot.programId);

    expect(await slotTrackId(slot.programId, `${slot.topic}-b`)).toBe(built.trackId);
    expect(await completedTitles(slot.userId, built.trackId)).toEqual([]);
  });

  it('does not resurrect a lesson the learner un-completed after the carry-over', async () => {
    const slot = await seedSlot('rerun');
    await prisma.progress.create({ data: { userId: slot.userId, lessonId: slot.lessons.limits } });

    const result = await regenerateTrack({ userId: slot.userId, programId: slot.programId, trackId: slot.trackId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rebuilt = await fulfillWith(result.requestId, slot.pathId, 'rerun');
    await maybeAssembleProgram(slot.programId);
    expect(await completedTitles(slot.userId, rebuilt.trackId)).toEqual(['continuity-only', 'limits-only']);

    await prisma.progress.deleteMany({ where: { userId: slot.userId, lessonId: rebuilt.lessons['limits-only'] } });
    // The assembler re-runs on its own (the stuck-Program sweep, a sibling finishing
    // later). A re-run must be a no-op, not a second carry-over.
    await maybeAssembleProgram(slot.programId);
    expect(await completedTitles(slot.userId, rebuilt.trackId)).toEqual(['continuity-only']);
  });
});
