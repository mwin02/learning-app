// Reports R6: the DB half of progress carry-over. Reads only — the INSERT is handed
// back to maybeAssembleProgram so it lands in the same transaction as the slot
// repoint, which is what guarantees the new Track is never visible with empty
// progress. Nothing here touches either Track: the old one stays as the evidence for
// why the rebuild happened, and Track immutability is unchanged.

import { prisma } from '@/lib/db';
import { carryOverProgress } from '@/lib/progress-carryover';

export type CarryOverPlan = {
  userId: string;
  oldTrackId: string;
  newTrackId: string;
  lessonIds: string[];
  completedBefore: number;
};

/**
 * Which lessons of the rebuilt Track the requester has effectively already done.
 *
 * Scoped to ONE user by design: progress is per-user and a rebuild only moves the
 * slot of the learner who asked for it, so crediting a co-enrolled learner off
 * someone else's completions would be inventing progress they never made.
 *
 * Returns an empty plan when the new Track already carries progress for this user —
 * the assembler can re-run (the stuck-Program sweep), and a re-run must not resurrect
 * lessons the learner has since un-completed.
 */
export async function planCarryOver(input: {
  userId: string;
  oldTrackId: string;
  newTrackId: string;
}): Promise<CarryOverPlan> {
  const { userId, oldTrackId, newTrackId } = input;
  const empty: CarryOverPlan = { ...input, lessonIds: [], completedBefore: 0 };

  const alreadyCarried = await prisma.progress.count({
    where: { userId, lesson: { trackId: newTrackId } },
  });
  if (alreadyCarried > 0) return empty;

  const [completed, newLessons] = await Promise.all([
    prisma.progress.findMany({
      where: { userId, lesson: { trackId: oldTrackId } },
      select: { lesson: { select: { id: true, conceptsTaught: true } } },
    }),
    prisma.lesson.findMany({
      where: { trackId: newTrackId },
      select: { id: true, conceptsTaught: true },
    }),
  ]);
  if (completed.length === 0) return empty;

  return {
    ...input,
    lessonIds: carryOverProgress(
      completed.map((row) => row.lesson),
      newLessons,
    ),
    completedBefore: completed.length,
  };
}
