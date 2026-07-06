// Frontend redesign Block 2: the program-wide progress read. The notebook
// program home shows per-course progress (done counts + the next incomplete
// lesson) across every built track of a program — one Progress query + one
// lesson-skeleton query, joined in memory. Server-side and read-only: marking
// complete still happens inside the per-track player; this powers the overview.

import { prisma } from '@/lib/db';

export type CourseProgress = {
  trackId: string;
  doneCount: number;
  totalCount: number;
  // First incomplete lesson in track order (null when the course is complete
  // or has no lessons).
  nextUp: { id: string; title: string } | null;
};

export async function loadProgramCourseProgress(
  userId: string | null,
  trackIds: string[]
): Promise<Map<string, CourseProgress>> {
  if (trackIds.length === 0) return new Map();

  const [lessons, completedRows] = await Promise.all([
    prisma.lesson.findMany({
      where: { trackId: { in: trackIds } },
      orderBy: { orderInTrack: 'asc' },
      select: { id: true, title: true, trackId: true },
    }),
    // Anonymous / dev-bypass viewers have no rows to read.
    userId
      ? prisma.progress.findMany({
          where: { userId, lesson: { trackId: { in: trackIds } } },
          select: { lessonId: true },
        })
      : Promise.resolve([]),
  ]);

  const completed = new Set(completedRows.map((r) => r.lessonId));
  const byTrack = new Map<string, CourseProgress>(
    trackIds.map((id) => [id, { trackId: id, doneCount: 0, totalCount: 0, nextUp: null }])
  );
  for (const lesson of lessons) {
    const cp = byTrack.get(lesson.trackId);
    if (!cp) continue;
    cp.totalCount += 1;
    if (completed.has(lesson.id)) cp.doneCount += 1;
    else if (!cp.nextUp) cp.nextUp = { id: lesson.id, title: lesson.title };
  }
  return byTrack;
}
