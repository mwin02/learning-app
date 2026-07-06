// Frontend redesign Block 2/3: the program-wide progress read. One lesson-
// skeleton query + one Progress query across a program's built tracks, joined
// in memory. Powers the program overview's table of contents (done counts +
// next incomplete lesson) and seeds the client ProgramShell provider (lesson
// lists + completed ids for the live accordion rail). Server-side and
// read-only: marking complete still happens through the per-track progress API.

import { prisma } from '@/lib/db';

export type CourseLesson = { id: string; title: string; sectionId: string | null };
export type CourseSection = { id: string; title: string };

export type CourseProgress = {
  trackId: string;
  // In track order — the rail's expanded lesson list. sectionId groups them
  // under `sections` (null for flat, un-sectioned tracks).
  lessons: CourseLesson[];
  sections: CourseSection[];
  completedIds: string[];
  doneCount: number;
  totalCount: number;
  // First incomplete lesson in track order (null when the course is complete
  // or has no lessons).
  nextUp: CourseLesson | null;
};

export async function loadProgramCourseProgress(
  userId: string | null,
  trackIds: string[]
): Promise<Map<string, CourseProgress>> {
  if (trackIds.length === 0) return new Map();

  const [lessons, sections, completedRows] = await Promise.all([
    prisma.lesson.findMany({
      where: { trackId: { in: trackIds } },
      orderBy: { orderInTrack: 'asc' },
      select: { id: true, title: true, trackId: true, sectionId: true },
    }),
    prisma.section.findMany({
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
    trackIds.map((id) => [
      id,
      {
        trackId: id,
        lessons: [],
        sections: [],
        completedIds: [],
        doneCount: 0,
        totalCount: 0,
        nextUp: null,
      },
    ])
  );
  for (const section of sections) {
    byTrack.get(section.trackId)?.sections.push({ id: section.id, title: section.title });
  }
  for (const lesson of lessons) {
    const cp = byTrack.get(lesson.trackId);
    if (!cp) continue;
    cp.lessons.push({ id: lesson.id, title: lesson.title, sectionId: lesson.sectionId });
    cp.totalCount += 1;
    if (completed.has(lesson.id)) {
      cp.completedIds.push(lesson.id);
      cp.doneCount += 1;
    } else if (!cp.nextUp) {
      cp.nextUp = { id: lesson.id, title: lesson.title, sectionId: lesson.sectionId };
    }
  }
  return byTrack;
}
