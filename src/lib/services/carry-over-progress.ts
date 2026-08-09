// Reports R6: the DB half of progress carry-over. Reads only — the writes are the
// caller's (maybeAssembleProgram), which pairs them with the CourseRequest.carriedOverAt
// marker in one small transaction. Nothing here touches either Track: the old one stays
// as the evidence for why the rebuild happened, and Track immutability is unchanged.

import { prisma } from '@/lib/db';
import { carryOverProgress, type CarriedLesson } from '@/lib/progress-carryover';

export type CarryOverPlan = {
  userId: string;
  oldTrackId: string;
  newTrackId: string;
  lessons: CarriedLesson[];
  completedBefore: number;
};

/**
 * Which lessons of the rebuilt Track the requester has effectively already done.
 *
 * Scoped to ONE user by design: progress is per-user and a rebuild only moves the
 * slot of the learner who asked for it, so crediting a co-enrolled learner off
 * someone else's completions would be inventing progress they never made.
 *
 * Whether the carry-over has ALREADY run is deliberately not inferred here. It used to
 * be, from the presence of Progress rows on the new Track — which made a full un-tick
 * of the carried lessons look like "never ran" and let the next assembler pass
 * resurrect them (F5). The caller owns that question now, via CourseRequest.carriedOverAt.
 */
export async function planCarryOver(input: {
  userId: string;
  oldTrackId: string;
  newTrackId: string;
}): Promise<CarryOverPlan> {
  const { userId, oldTrackId, newTrackId } = input;

  const [completed, newLessons] = await Promise.all([
    prisma.progress.findMany({
      where: { userId, lesson: { trackId: oldTrackId } },
      select: { completedAt: true, lesson: { select: { id: true, conceptsTaught: true } } },
    }),
    prisma.lesson.findMany({
      where: { trackId: newTrackId },
      select: { id: true, conceptsTaught: true },
    }),
  ]);
  if (completed.length === 0) return { ...input, lessons: [], completedBefore: 0 };

  return {
    ...input,
    lessons: carryOverProgress(
      completed.map((row) => ({ ...row.lesson, completedAt: row.completedAt })),
      newLessons,
    ),
    completedBefore: completed.length,
  };
}
