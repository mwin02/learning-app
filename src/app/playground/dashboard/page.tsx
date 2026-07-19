import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';
import { ResourceLookup } from './resource-lookup';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Dashboard · Playground' };

// Playground revamp Block 2: the operator landing page. One glance answers
// "what's waiting on me?" (action queues, each mirroring its tab's own query),
// "is the worker healthy?" and "what shape is the library in?". Read-only
// static snapshot — reload to refresh, same as the queue page.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function fmtAge(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

// A count card that links to the tab where the action happens. Red badge when
// non-zero and the count means "a human decision is overdue".
function ActionCard({
  href,
  label,
  count,
  detail,
}: {
  href: string;
  label: string;
  count: number;
  detail?: string;
}) {
  return (
    <Link
      href={href}
      className={`flex flex-col gap-1 rounded border p-4 hover:bg-gray-50 ${
        count > 0 ? 'border-red-300' : 'border-gray-200'
      }`}
    >
      <span className={`text-3xl font-bold ${count > 0 ? 'text-red-700' : 'text-gray-400'}`}>
        {count}
      </span>
      <span className="text-sm font-medium">{label}</span>
      {detail && <span className="text-xs text-gray-500">{detail}</span>}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xl font-semibold">{value}</span>
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  );
}

export default async function DashboardPage() {
  await requireAdminPage();

  const now = Date.now();
  const dayAgo = new Date(now - DAY_MS);
  const weekAgo = new Date(now - WEEK_MS);

  const [
    decompReview,
    decompPending,
    pendingReview,
    pendingBlocked,
    openFindings,
    failedRequests,
    failedPrograms,
    brokenTracks,
    crQueued,
    crRunning,
    oldestQueued,
    fulfilled24h,
    remQueued,
    remRunning,
    remSucceeded24h,
    resourcesByStatus,
    deprecated7d,
    votesTotal,
    votes7d,
    votesByValue,
  ] = await Promise.all([
    // Action queues — each count uses the same where-clause as its tab.
    prisma.resource.count({
      where: { parentResourceId: null, decompositionStatus: 'human_review' },
    }),
    prisma.resource.count({
      where: { parentResourceId: null, decompositionStatus: 'pending' },
    }),
    prisma.resource.count({ where: { parentResourceId: null, status: 'pending_review' } }),
    prisma.resource.count({
      where: {
        parentResourceId: null,
        status: 'pending_review',
        decompositionStatus: { in: ['pending', 'human_review'] },
      },
    }),
    prisma.pathReview.findMany({
      where: { resolved: false },
      select: { pathId: true, kind: true, path: { select: { topic: true } } },
    }),
    prisma.courseRequest.count({ where: { status: 'failed' } }),
    prisma.program.count({ where: { status: 'failed', courseRequests: { none: {} } } }),
    prisma.track.count({
      where: {
        lessons: { some: { resources: { some: { resource: { status: 'deprecated' } } } } },
      },
    }),
    // Worker health.
    prisma.courseRequest.count({ where: { status: 'queued' } }),
    prisma.courseRequest.count({ where: { status: 'running' } }),
    prisma.courseRequest.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.courseRequest.count({ where: { status: 'fulfilled', updatedAt: { gte: dayAgo } } }),
    prisma.remediationJob.count({ where: { state: 'queued' } }),
    prisma.remediationJob.count({ where: { state: 'running' } }),
    prisma.remediationJob.count({ where: { state: 'succeeded', updatedAt: { gte: dayAgo } } }),
    // Library.
    prisma.resource.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.resource.count({ where: { status: 'deprecated', updatedAt: { gte: weekAgo } } }),
    prisma.resourceRating.count(),
    prisma.resourceRating.count({ where: { updatedAt: { gte: weekAgo } } }),
    prisma.resourceRating.groupBy({ by: ['value'], _count: { _all: true } }),
  ]);

  // Findings grouped per path so each affected map gets one linkable row.
  const findingsByPath = new Map<string, { topic: string; kinds: string[] }>();
  for (const f of openFindings) {
    const e = findingsByPath.get(f.pathId) ?? { topic: f.path.topic, kinds: [] };
    e.kinds.push(f.kind);
    findingsByPath.set(f.pathId, e);
  }

  const statusCount = (s: string) =>
    resourcesByStatus.find((r) => r.status === s)?._count._all ?? 0;
  const voteCount = (v: number) => votesByValue.find((r) => r.value === v)?._count._all ?? 0;

  return (
    <main className="p-6 flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
          <p className="text-sm text-gray-600">
            Static snapshot — reload to refresh. Cards link to the tab where the action happens.
          </p>
        </div>
        <ResourceLookup />
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Waiting on you</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <ActionCard
            href="/playground/decomposition-review"
            label="Decomposition review"
            count={decompReview}
            detail={decompPending > 0 ? `+${decompPending} pending retry` : undefined}
          />
          <ActionCard
            href="/playground/pending-review"
            label="Pending review"
            count={pendingReview}
            detail={pendingBlocked > 0 ? `${pendingBlocked} blocked on decomposition` : undefined}
          />
          <ActionCard
            href="/playground/failed-builds"
            label="Failed builds"
            count={failedRequests + failedPrograms}
            detail={failedPrograms > 0 ? `${failedPrograms} plan-pass failures` : undefined}
          />
          <ActionCard
            href="/playground/broken-tracks"
            label="Broken tracks"
            count={brokenTracks}
          />
          <ActionCard
            href="/playground/map-review"
            label="Map review findings"
            count={openFindings.length}
            detail={
              findingsByPath.size > 0 ? `across ${findingsByPath.size} path(s)` : undefined
            }
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          Worker{' '}
          <Link href="/playground/queue" className="text-sm font-normal underline text-gray-600">
            queue detail →
          </Link>
        </h2>
        <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
          <Stat label="builds queued" value={crQueued} />
          <Stat label="builds running" value={crRunning} />
          <Stat
            label="oldest queued"
            value={oldestQueued ? fmtAge(now - oldestQueued.createdAt.getTime()) : '—'}
          />
          <Stat label="fulfilled, 24h" value={fulfilled24h} />
          <Stat label="remediation queued/running" value={`${remQueued}/${remRunning}`} />
          <Stat label="remediation done, 24h" value={remSucceeded24h} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Library</h2>
        <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
          <Stat label="active resources" value={statusCount('active')} />
          <Stat label="pending review" value={statusCount('pending_review')} />
          <Stat label="deprecated" value={statusCount('deprecated')} />
          <Stat label="deprecated, 7d" value={deprecated7d} />
          <Stat label="votes (👍/👎)" value={`${voteCount(1)}/${voteCount(-1)}`} />
          <Stat label="votes, 7d" value={votes7d} />
        </div>
        <p className="text-xs text-gray-500">
          {votesTotal} votes all-time. “Deprecated, 7d” counts operator rejects and automatic
          low-trust evictions together — the row is the same either way.
        </p>
      </section>
    </main>
  );
}
