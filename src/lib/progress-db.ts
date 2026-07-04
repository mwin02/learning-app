// Phase 3f: DB-backed lesson progress — the query layer under
// /api/progress/[trackId]. Kept out of the route file so integration tests can
// exercise the real Prisma queries directly (route handlers can't carry a
// session under vitest — withAuth 401s without Supabase config or the dev
// bypass, which is dead outside NODE_ENV=development).

import { prisma } from '@/lib/db';

/** Completed lessonIds for one user within one track. */
export async function loadCompletedLessonIds(userId: string, trackId: string): Promise<string[]> {
  const rows = await prisma.progress.findMany({
    where: { userId, lesson: { trackId } },
    select: { lessonId: true },
  });
  return rows.map((r) => r.lessonId);
}

/**
 * Upsert (complete) or delete (incomplete) one Progress row. Returns false when
 * the lesson doesn't exist IN THIS TRACK — the route turns that into a 404, so
 * a lessonId can't write progress into a track the caller wasn't authorized for.
 */
export async function setLessonComplete(
  userId: string,
  trackId: string,
  lessonId: string,
  complete: boolean
): Promise<boolean> {
  const lesson = await prisma.lesson.findFirst({
    where: { id: lessonId, trackId },
    select: { id: true },
  });
  if (!lesson) return false;
  if (complete) {
    await prisma.progress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: { userId, lessonId },
      update: {},
    });
  } else {
    await prisma.progress.deleteMany({ where: { userId, lessonId } });
  }
  return true;
}

/**
 * Bulk-complete for the one-shot localStorage → DB migration. Ids that don't
 * belong to this track are silently dropped (anonymous local data is
 * untrusted); rows that already exist are left untouched (skipDuplicates), so
 * an earlier completedAt is never rewritten. Returns the number of lessonIds
 * accepted (in-track), not rows inserted.
 */
export async function bulkCompleteLessons(
  userId: string,
  trackId: string,
  lessonIds: string[]
): Promise<number> {
  if (lessonIds.length === 0) return 0;
  const valid = await prisma.lesson.findMany({
    where: { trackId, id: { in: lessonIds } },
    select: { id: true },
  });
  if (valid.length > 0) {
    await prisma.progress.createMany({
      data: valid.map((l) => ({ userId, lessonId: l.id })),
      skipDuplicates: true,
    });
  }
  return valid.length;
}
