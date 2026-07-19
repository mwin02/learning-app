import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';
import { FindingActions } from './finding-actions';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Map review · Playground' };

// Playground revamp Block 3: the cross-path Pre-Freeze Map Review worklist.
// The critic (review-map.ts) writes PathReview findings; until now the only
// consumers were the map-review API (driven by the review-map-findings skill)
// and the per-path count on the dashboard. This tab lists every OPEN finding
// grouped by Path, with the same merge / dismiss / keep decisions the API
// offers — merge is per-winner since the operator names the surviving concept.

const KIND_BADGE: Record<string, string> = {
  duplication: 'bg-blue-100 text-blue-800',
  hollow: 'bg-red-100 text-red-800',
  granularity: 'bg-amber-100 text-amber-900',
};

export default async function MapReviewPage() {
  await requireAdminPage();

  const findings = await prisma.pathReview.findMany({
    where: { resolved: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      pathId: true,
      kind: true,
      conceptSlugs: true,
      message: true,
      createdAt: true,
      path: { select: { topic: true, status: true } },
    },
  });

  // Group per Path so the operator works one map at a time.
  const byPath = new Map<string, { topic: string; status: string; rows: typeof findings }>();
  for (const f of findings) {
    const e = byPath.get(f.pathId) ?? { topic: f.path.topic, status: f.path.status, rows: [] };
    e.rows.push(f);
    byPath.set(f.pathId, e);
  }

  return (
    <main className="p-6 flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold mb-2">Map review</h1>
        <p className="max-w-3xl text-sm text-gray-600">
          Open Pre-Freeze Map Review findings, grouped by Path. <strong>Merge</strong> collapses a
          duplication&apos;s two concepts into the winner you pick (the loser&apos;s edges and
          resources repoint, then it is deleted — refused if it would create a prerequisite
          cycle). <strong>Dismiss</strong> = not a real problem; <strong>Keep as-is</strong> = real
          but intentionally left alone. The <code>review-map-findings</code> skill drives the same
          API for agent-led triage.
        </p>
      </header>

      {byPath.size === 0 && <p className="text-sm text-gray-600">No open findings. 🎉</p>}

      {[...byPath.entries()].map(([pathId, group]) => (
        <section key={pathId} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            <Link href={`/playground/paths/${pathId}`} className="underline">
              {group.topic}
            </Link>{' '}
            <span className="text-sm font-normal text-gray-500">
              {group.status} · {group.rows.length} finding{group.rows.length === 1 ? '' : 's'}
            </span>
          </h2>
          <ul className="flex flex-col gap-3">
            {group.rows.map((f) => (
              <li key={f.id} className="rounded border border-gray-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_BADGE[f.kind] ?? 'bg-gray-100 text-gray-700'}`}
                  >
                    {f.kind}
                  </span>
                  <span className="font-mono text-xs text-gray-600">
                    {f.conceptSlugs.join(' · ')}
                  </span>
                  <span className="text-xs text-gray-400">
                    {f.createdAt.toISOString().slice(0, 10)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-800">{f.message}</p>
                <FindingActions reviewId={f.id} kind={f.kind} conceptSlugs={f.conceptSlugs} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
