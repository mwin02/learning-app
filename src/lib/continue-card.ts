// UI Block 8: data for the home page's continue card. Picks "the last program
// the viewer worked on": the program containing the track of their most recent
// lesson completion (most recently enrolled wins when a shared track sits in
// several enrolled programs), falling back to the newest browsable enrollment
// for viewers with no completions yet. Returns null when nothing is browsable
// (no enrollments, or all still planning/building/failed with nothing built).

import { prisma } from '@/lib/db';
import { loadProgramCourseProgress } from '@/lib/program-progress';
import type { ContinueCardData } from '@/app/_components/ContinueCard';

export async function loadContinueCard(userId: string): Promise<ContinueCardData | null> {
  const enrollments = await prisma.enrolledProgram.findMany({
    where: { userId },
    orderBy: { enrolledAt: 'desc' },
    select: {
      program: {
        select: {
          id: true,
          title: true,
          goal: true,
          status: true,
          userId: true,
          programPaths: {
            orderBy: { orderInProgram: 'asc' },
            select: { trackId: true },
          },
        },
      },
    },
  });

  // Browsable = something to link into: a built track behind a settled program.
  const browsable = enrollments
    .map(({ program }) => ({
      program,
      builtIds: program.programPaths.flatMap((s) => (s.trackId ? [s.trackId] : [])),
    }))
    .filter(
      ({ program, builtIds }) =>
        ['ready', 'partial'].includes(program.status) && builtIds.length > 0
    );
  if (browsable.length === 0) return null;

  const lastDone = await prisma.progress.findFirst({
    where: {
      userId,
      lesson: { trackId: { in: browsable.flatMap((b) => b.builtIds) } },
    },
    orderBy: { completedAt: 'desc' },
    select: { lesson: { select: { trackId: true } } },
  });

  // browsable is enrolledAt-desc, so `find` resolves shared-track ambiguity to
  // the most recently enrolled program; no completions → newest enrollment.
  const chosen = lastDone
    ? (browsable.find((b) => b.builtIds.includes(lastDone.lesson.trackId)) ?? browsable[0])
    : browsable[0];

  const { program, builtIds } = chosen;
  const progress = await loadProgramCourseProgress(userId, builtIds);
  // builtIds follow orderInProgram, so the first incomplete lesson across them
  // is the program's next-up in plan order.
  const perTrack = builtIds.map((id) => progress.get(id)).filter((cp) => cp != null);
  const nextCp = perTrack.find((cp) => cp.nextUp);
  const done = perTrack.reduce((s, cp) => s + cp.doneCount, 0);
  const total = perTrack.reduce((s, cp) => s + cp.totalCount, 0);

  return {
    programId: program.id,
    title: program.title ?? (program.userId === userId ? program.goal : 'Learning program'),
    nextUp: nextCp?.nextUp?.title ?? null,
    href: nextCp?.nextUp
      ? `/programs/${program.id}/${nextCp.trackId}/${nextCp.nextUp.id}`
      : `/programs/${program.id}`,
    done,
    total,
    started: done > 0,
  };
}
