// Phase 3e, reskinned in frontend-redesign Block 6: "My programs" — the
// signed-in home as a notebook dashboard. Every Program the viewer is enrolled
// in (newest first) as a table-of-contents chapter with real program-wide
// progress + next-up; inert rows while builds are in flight (auto-refresh
// keeps them live). Creators see their own goal in the meta line; enrolled
// non-creators only ever see the generated title.

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getViewer } from '@/lib/auth/viewer';
import { loadProgramCourseProgress } from '@/lib/program-progress';
import { Desk, Sheet } from '@/components/notebook/Sheet';
import { AutoRefresh } from './_components/AutoRefresh';
import { NotebookMyPrograms, type DashboardProgram } from './_components/NotebookMyPrograms';

export const dynamic = 'force-dynamic';

export default async function MyProgramsPage() {
  const viewer = await getViewer();
  if (!viewer.userId) redirect('/signin?next=%2Fprograms');

  const [user, enrollments] = await Promise.all([
    prisma.user.findUnique({ where: { id: viewer.userId }, select: { name: true } }),
    prisma.enrolledProgram.findMany({
      where: { userId: viewer.userId },
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
    }),
  ]);

  // One progress read across every built track of every program, grouped back
  // per program below (lesson done/total + the first incomplete lesson).
  const allBuiltIds = enrollments.flatMap(({ program }) =>
    program.programPaths.flatMap((s) => (s.trackId ? [s.trackId] : []))
  );
  const progress = await loadProgramCourseProgress(viewer.userId, allBuiltIds);

  const programs: DashboardProgram[] = enrollments.map(({ program: p }) => {
    const isCreator = p.userId === viewer.userId;
    const builtIds = p.programPaths.flatMap((s) => (s.trackId ? [s.trackId] : []));
    const perTrack = builtIds.map((id) => progress.get(id)).filter((cp) => cp != null);
    // Next-up = the first incomplete lesson in plan order across the program.
    const nextUp = perTrack.find((cp) => cp.nextUp)?.nextUp?.title ?? null;
    return {
      id: p.id,
      title: p.title ?? (isCreator ? p.goal : 'Learning program'),
      goalNote: isCreator && p.title ? p.goal : null,
      status: p.status,
      courseCount: p.programPaths.length,
      builtCount: builtIds.length,
      doneLessons: perTrack.reduce((s, cp) => s + cp.doneCount, 0),
      totalLessons: perTrack.reduce((s, cp) => s + cp.totalCount, 0),
      nextUp,
    };
  });

  const anyBuilding = programs.some((p) => ['planning', 'building'].includes(p.status));
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? null;

  return (
    <Desk maxWidth={900}>
      {anyBuilding && <AutoRefresh />}
      <Sheet>
        <NotebookMyPrograms firstName={firstName} programs={programs} />
      </Sheet>
    </Desk>
  );
}
