import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';

export const dynamic = 'force-dynamic';

export default async function PathDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isDevAuthEnabled()) notFound();

  const { id } = await params;

  const path = await prisma.path.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { order: 'asc' },
        include: { resource: true },
      },
    },
  });

  if (!path) notFound();

  return (
    <main className="p-6 flex flex-col gap-6">
      <div>
        <Link href="/playground/path-generation" className="text-sm underline">
          ← back to path generation
        </Link>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{path.title}</h1>
        <div className="text-sm text-gray-600">
          <span>topic: {path.topic}</span>
          {' · '}
          <span>difficulty: {path.difficulty}</span>
          {' · '}
          <span>{path.createdAt.toISOString()}</span>
        </div>
        <p className="mt-2 text-sm">{path.summary}</p>
        <dl className="mt-2 text-xs text-gray-600 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <dt>id</dt>
          <dd>{path.id}</dd>
          <dt>timeframeWeeks</dt>
          <dd>{path.inputTimeframeWeeks ?? '—'}</dd>
          <dt>hoursPerWeek</dt>
          <dd>{path.inputHoursPerWeek ?? '—'}</dd>
          <dt>priorKnowledge</dt>
          <dd>{path.inputPriorKnowledge ?? '—'}</dd>
          <dt>createdById</dt>
          <dd>{path.createdById ?? '—'}</dd>
        </dl>
      </header>

      <section>
        <h2 className="text-xl font-semibold mb-3">Items ({path.items.length})</h2>
        <ol className="flex flex-col gap-3">
          {path.items.map((item) => {
            const r = item.resource;
            return (
              <li key={item.id} className="border rounded p-3 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-gray-500">#{item.order}</span>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline"
                  >
                    {r.title}
                  </a>
                  {item.isCheckpoint && (
                    <span className="text-xs bg-yellow-100 text-yellow-900 px-1 rounded">
                      checkpoint
                    </span>
                  )}
                  {item.status !== 'active' && (
                    <span className="text-xs bg-gray-200 px-1 rounded">{item.status}</span>
                  )}
                </div>
                <div className="text-xs text-gray-600 mt-1 break-all">{r.url}</div>
                <div className="text-xs mt-1">
                  <Link href={`/playground/resource/${r.id}`} className="underline">
                    inspect resource →
                  </Link>
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  <span>type: {r.type}</span>
                  {' · '}
                  <span>tier: {r.tier}</span>
                  {' · '}
                  <span>{r.durationMin} min</span>
                  {' · '}
                  <span>difficulty: {r.difficulty}</span>
                  {' · '}
                  <span>trust: {r.trustScore.toFixed(2)}</span>
                  {' · '}
                  <span>origin: {r.origin}</span>
                  {r.decompositionStatus !== 'atomic' && (
                    <>
                      {' · '}
                      <span>decomp: {r.decompositionStatus}</span>
                    </>
                  )}
                </div>
                <p className="mt-2 text-sm">
                  <span className="font-medium">rationale:</span> {item.rationale}
                </p>
                {r.summary && (
                  <p className="mt-1 text-xs text-gray-600">
                    <span className="font-medium">resource summary:</span> {r.summary}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-600">raw JSON</summary>
        <pre className="mt-2 p-3 bg-gray-100 rounded overflow-auto">
          {JSON.stringify(path, null, 2)}
        </pre>
      </details>
    </main>
  );
}
