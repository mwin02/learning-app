// DB integration tests for Phase 3f (DB-backed lesson progress): the
// progress-db query layer under /api/progress/[trackId]. Real DB, no LLM.
// Self-cleaning via the __verify_prog3f__ marker. Skips cleanly without
// DATABASE_URL (describeDb).
//
// NOTE: requires the 3a migration on the target DB (User.email) — fails on a
// pre-3a shared dev DB until `prisma migrate deploy` runs there.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import {
  loadCompletedLessonIds,
  setLessonComplete,
  bulkCompleteLessons,
} from '@/lib/progress-db';
import { describeDb } from './db';

const MARK = '__verify_prog3f__';
const USER_ID = `${MARK}user`;

async function cleanup() {
  // Deleting the user cascades Progress; deleting the paths cascades tracks/lessons.
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

async function makeTrackWithLessons(name: string, lessonCount: number) {
  const path = await prisma.path.create({ data: { topic: `${MARK}${name}` }, select: { id: true } });
  const track = await prisma.track.create({
    data: { pathId: path.id, status: 'ready', title: `Track ${name}` },
    select: { id: true },
  });
  const lessonIds: string[] = [];
  for (let i = 1; i <= lessonCount; i++) {
    const lesson = await prisma.lesson.create({
      data: {
        trackId: track.id,
        orderInTrack: i,
        title: `${MARK}lesson ${i}`,
        summary: 'verify',
        conceptsTaught: [],
        estMinutes: 10,
      },
      select: { id: true },
    });
    lessonIds.push(lesson.id);
  }
  return { trackId: track.id, lessonIds };
}

describeDb('track progress queries (3f)', () => {
  let trackId: string;
  let lessons: string[];
  let otherLesson: string; // a lesson in a DIFFERENT track — must never leak in

  beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER_ID, email: `${MARK}@example.test` } });
    const main = await makeTrackWithLessons('main', 3);
    trackId = main.trackId;
    lessons = main.lessonIds;
    const other = await makeTrackWithLessons('other', 1);
    otherLesson = other.lessonIds[0];
  });
  afterAll(cleanup);

  it('setLessonComplete upserts, is idempotent, and delete removes the row', async () => {
    expect(await setLessonComplete(USER_ID, trackId, lessons[0], true)).toBe(true);
    expect(await setLessonComplete(USER_ID, trackId, lessons[0], true)).toBe(true); // idempotent
    expect(await loadCompletedLessonIds(USER_ID, trackId)).toEqual([lessons[0]]);

    expect(await setLessonComplete(USER_ID, trackId, lessons[0], false)).toBe(true);
    expect(await loadCompletedLessonIds(USER_ID, trackId)).toEqual([]);
    // Un-completing an already-absent row is still a success (deleteMany).
    expect(await setLessonComplete(USER_ID, trackId, lessons[0], false)).toBe(true);
  });

  it('rejects lessons that are not in the track (unknown id or foreign track)', async () => {
    expect(await setLessonComplete(USER_ID, trackId, 'no-such-lesson', true)).toBe(false);
    expect(await setLessonComplete(USER_ID, trackId, otherLesson, true)).toBe(false);
    expect(await prisma.progress.count({ where: { userId: USER_ID } })).toBe(0);
  });

  it('bulkCompleteLessons drops foreign ids, skips duplicates, and reports accepted count', async () => {
    await setLessonComplete(USER_ID, trackId, lessons[0], true); // pre-existing row
    const accepted = await bulkCompleteLessons(USER_ID, trackId, [
      lessons[0], // duplicate — kept, not rewritten
      lessons[1],
      otherLesson, // foreign track — dropped
      'no-such-lesson', // unknown — dropped
    ]);
    expect(accepted).toBe(2);
    expect((await loadCompletedLessonIds(USER_ID, trackId)).sort()).toEqual(
      [lessons[0], lessons[1]].sort()
    );
    // The foreign track saw nothing.
    expect(await prisma.progress.count({ where: { userId: USER_ID, lessonId: otherLesson } })).toBe(0);
    expect(await bulkCompleteLessons(USER_ID, trackId, [])).toBe(0);
  });
});
