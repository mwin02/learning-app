// Phase 3e: "My programs" — the signed-in home. Barebones integration-test
// surface (the designed dashboard comes with the frontend pass): every Program
// the viewer is enrolled in, newest first, with live build status (auto-refresh
// while anything is still planning/building). Creators see their own goal as a
// subtitle; enrolled non-creators only ever see the generated title.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getViewer } from '@/lib/auth/viewer';
import { AutoRefresh } from './_components/AutoRefresh';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  planning: 'Planning…',
  building: 'Building…',
  ready: 'Ready',
  partial: 'Ready (partial)',
  failed: 'Failed',
};

export default async function MyProgramsPage() {
  const viewer = await getViewer();
  if (!viewer.userId) redirect('/auth/login?next=%2Fprograms');

  const enrollments = await prisma.enrolledProgram.findMany({
    where: { userId: viewer.userId },
    orderBy: { enrolledAt: 'desc' },
    select: {
      program: {
        select: {
          id: true,
          title: true,
          description: true,
          goal: true,
          status: true,
          userId: true,
          createdAt: true,
          programPaths: { select: { trackId: true } },
        },
      },
    },
  });
  const anyBuilding = enrollments.some((e) =>
    ['planning', 'building'].includes(e.program.status)
  );

  return (
    <div className="min-h-screen bg-surface px-6 py-10 text-ink">
      {anyBuilding && <AutoRefresh />}
      <main className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-bold tracking-[-0.5px]">My programs</h1>
          <Link href="/programs/new" className="text-sm font-semibold text-brand underline">
            + New program
          </Link>
        </div>

        {enrollments.length === 0 ? (
          <div className="card p-6">
            <p className="text-body">
              Nothing here yet.{' '}
              <Link href="/programs/new" className="text-brand underline">
                Create your first program
              </Link>
              .
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {enrollments.map(({ program: p }) => {
              const isCreator = p.userId === viewer.userId;
              const built = p.programPaths.filter((s) => s.trackId).length;
              return (
                <li key={p.id} className="card p-5">
                  <Link href={`/programs/${p.id}`} className="block">
                    <div className="mb-1 flex items-baseline justify-between gap-4">
                      <span className="font-semibold">
                        {p.title ?? (isCreator ? p.goal : 'Learning program')}
                      </span>
                      <span className="meta-xs shrink-0">
                        {STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </div>
                    {isCreator && p.title && <div className="meta-xs mb-1">{p.goal}</div>}
                    <div className="meta-xs">
                      {built}/{p.programPaths.length} tracks built ·{' '}
                      {p.createdAt.toISOString().slice(0, 10)}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="meta-xs mt-8">
          <Link href="/" className="underline">
            ← Home
          </Link>
        </p>
      </main>
    </div>
  );
}
