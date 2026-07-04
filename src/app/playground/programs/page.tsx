import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';
import { PROGRAM_STATUS_STYLE } from './status-style';

export const dynamic = 'force-dynamic';

// Phase 2.75e (playground stub): read-only list of Programs — the goal-driven,
// multi-topic plans. Each row links to the phased detail view. Just enough to eyeball
// a built Program end-to-end before the polished learner-facing render lands
// post-Phase-3 (the real 2.75e). Newest first.
const ROW_CAP = 200;

export default async function ProgramsListPage() {
  await requireAdminPage();

  const programs = await prisma.program.findMany({
    orderBy: { createdAt: 'desc' },
    take: ROW_CAP,
    select: {
      id: true,
      goal: true,
      status: true,
      totalHoursPerWeek: true,
      totalWeeks: true,
      createdAt: true,
      _count: { select: { programPaths: true } },
    },
  });

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-bold mb-2">Programs</h1>
        <p className="text-sm text-gray-600 max-w-3xl">
          Goal-driven, multi-topic plans. A synchronous plan pass decomposes a goal into budgeted,
          gated topics that fan out onto the <code>CourseRequest</code> queue; the worker builds each
          child Track and the assembler finalizes the Program. Click one to see its phased plan.
        </p>
      </section>

      {programs.length === 0 ? (
        <p className="text-sm text-gray-600">
          No programs yet. Generate one via <code>POST /api/generate-program</code>.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {programs.map((p) => (
            <li key={p.id} className="border rounded p-4 text-sm flex flex-col gap-1">
              <div className="flex items-center gap-3 flex-wrap">
                <Link href={`/playground/programs/${p.id}`} className="font-medium underline">
                  {p.goal}
                </Link>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                    PROGRAM_STATUS_STYLE[p.status] ?? 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {p.status}
                </span>
              </div>
              <p className="text-xs text-gray-500">
                {p._count.programPaths} topic{p._count.programPaths === 1 ? '' : 's'} ·{' '}
                {p.totalHoursPerWeek}h/wk × {p.totalWeeks}w ·{' '}
                <span className="font-mono">{p.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
