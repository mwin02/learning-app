import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { STATUS_STYLE } from './status-style';

export const dynamic = 'force-dynamic';

// Phase 2.5d-5: read-only inspector for the topic concept maps (Path = an
// input-agnostic concept map). This index lists every built map; the detail page
// renders its spine DAG + per-concept candidates. Observability only — the
// human/agent edit surface is a later block (2.5d-6/7).
export default async function ConceptMapsPage() {
  if (!isDevAuthEnabled()) notFound();

  const paths = await prisma.path.findMany({
    select: {
      id: true,
      topic: true,
      status: true,
      updatedAt: true,
      _count: { select: { concepts: true } },
    },
    orderBy: [{ topic: 'asc' }],
  });

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-bold mb-2">Concept maps</h1>
        <p className="text-sm text-gray-600 max-w-2xl">
          Each <strong>Path</strong> is an input-agnostic concept map for a whole topic — a spine of{' '}
          <code>Concept</code> nodes, a prerequisite DAG between them, and per-concept candidate
          resources. <code>spine_ready</code> means every spine concept has a qualifying{' '}
          <code>teaches</code> primary; <code>building</code> means it has unfilled spine holes.
        </p>
      </section>

      {paths.length === 0 ? (
        <p className="text-sm text-gray-600">No concept maps built yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {paths.map((p) => {
            const style = STATUS_STYLE[p.status] ?? 'bg-gray-100 text-gray-700';
            return (
              <li key={p.id} className="border rounded p-3 text-sm flex items-center gap-3">
                <Link href={`/playground/concept-maps/${p.id}`} className="font-medium underline">
                  {p.topic}
                </Link>
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${style}`}>
                  {p.status}
                </span>
                <span className="text-gray-500 text-xs">
                  {p._count.concepts} concept{p._count.concepts === 1 ? '' : 's'}
                </span>
                <span className="text-gray-400 text-xs ml-auto">
                  {p.updatedAt.toISOString().slice(0, 10)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
