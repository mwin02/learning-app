import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';

export const dynamic = 'force-dynamic';

// Worker queue monitor — a live snapshot of what the course-worker is doing.
// The worker's tickOnce() claims the oldest `queued` CourseRequest, builds it,
// and (mid-build) runs a RemediationJob sub-queue to source spine holes. This
// page shows both queues in three lanes each: Pending (waiting to be claimed),
// Running (claimed, in flight), and Recently finished (successful completions).
// Read-only static snapshot — reload to refresh. Failures are triaged on the
// sibling /playground/failed-builds page, so "finished" here is success only.

// Active lanes rarely exceed a handful (single-concurrency worker), but cap
// defensively. Finished is intentionally short — a recent-throughput glance.
const ACTIVE_CAP = 200;
const FINISHED_CAP = 25;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtWhen(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// A labelled lane (Pending / Running / Recently finished) with a count and an
// empty state. `capped` flags a truncated active lane.
function Lane({
  title,
  count,
  capped,
  children,
}: {
  title: string;
  count: number;
  capped?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-gray-700">
        {title} <span className="text-gray-400 font-normal">({count})</span>
      </h3>
      {count === 0 ? (
        <p className="text-xs text-gray-400">none</p>
      ) : (
        <ul className="flex flex-col gap-1.5">{children}</ul>
      )}
      {capped && (
        <p className="text-2xs text-amber-800">Showing the first {ACTIVE_CAP} only.</p>
      )}
    </section>
  );
}

function Item({
  topic,
  meta,
  href,
  programId,
}: {
  topic: string;
  meta: string;
  href?: string;
  programId?: string | null;
}) {
  return (
    <li className="flex items-center gap-2 flex-wrap text-xs border-l-2 border-gray-200 pl-2 py-0.5">
      {href ? (
        <Link href={href} className="font-mono font-medium text-gray-800 underline">
          {topic}
        </Link>
      ) : (
        <span className="font-mono font-medium text-gray-800">{topic}</span>
      )}
      <span className="text-gray-500">{meta}</span>
      {programId && (
        <Link href={`/playground/programs/${programId}`} className="text-2xs text-gray-400 underline">
          program
        </Link>
      )}
    </li>
  );
}

export default async function QueuePage() {
  await requireAdminPage();

  const now = Date.now();
  const crSelect = {
    id: true,
    topic: true,
    createdAt: true,
    claimedAt: true,
    updatedAt: true,
    programId: true,
    trackId: true,
  } as const;
  const remSelect = {
    id: true,
    createdAt: true,
    claimedAt: true,
    updatedAt: true,
    holeSlugs: true,
    path: { select: { topic: true } },
  } as const;

  const [
    buildPending,
    buildRunning,
    buildDone,
    remPending,
    remRunning,
    remDone,
  ] = await Promise.all([
    // Pending = claim order (oldest first, the worker's own ORDER BY).
    prisma.courseRequest.findMany({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, take: ACTIVE_CAP, select: crSelect }),
    prisma.courseRequest.findMany({ where: { status: 'running' }, orderBy: { claimedAt: 'asc' }, take: ACTIVE_CAP, select: crSelect }),
    // Ordered by createdAt (not finish time) so @@index([status, createdAt])
    // serves it as an index scan + limit — no full scan of the unbounded
    // `fulfilled` history. For a FIFO queue this is near finish-order; the
    // displayed timestamp is still the true finish time (updatedAt).
    prisma.courseRequest.findMany({ where: { status: 'fulfilled' }, orderBy: { createdAt: 'desc' }, take: FINISHED_CAP, select: crSelect }),
    prisma.remediationJob.findMany({ where: { state: 'queued' }, orderBy: { createdAt: 'asc' }, take: ACTIVE_CAP, select: remSelect }),
    prisma.remediationJob.findMany({ where: { state: 'running' }, orderBy: { claimedAt: 'asc' }, take: ACTIVE_CAP, select: remSelect }),
    prisma.remediationJob.findMany({ where: { state: 'succeeded' }, orderBy: { updatedAt: 'desc' }, take: FINISHED_CAP, select: remSelect }),
  ]);

  return (
    <main className="p-6 flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-bold mb-2">Worker queue</h1>
        <p className="text-sm text-gray-600 max-w-3xl">
          A snapshot of the course-worker. It claims the oldest <code>queued</code>{' '}
          <code>CourseRequest</code>, builds it, and mid-build runs a{' '}
          <code>RemediationJob</code> sub-queue to source spine holes. Single-concurrency, so at most
          one of each is <em>running</em> at a time. Static snapshot — reload to refresh; failures are
          triaged on <Link href="/playground/failed-builds" className="underline">Failed builds</Link>.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Build queue (CourseRequest)</h2>
        <div className="grid gap-6 md:grid-cols-3">
          <Lane title="Pending" count={buildPending.length} capped={buildPending.length === ACTIVE_CAP}>
            {buildPending.map((r, i) => (
              <Item
                key={r.id}
                topic={r.topic}
                meta={`#${i + 1} · waiting ${fmtElapsed(now - r.createdAt.getTime())}`}
                programId={r.programId}
              />
            ))}
          </Lane>
          <Lane title="Running" count={buildRunning.length} capped={buildRunning.length === ACTIVE_CAP}>
            {buildRunning.map((r) => (
              <Item
                key={r.id}
                topic={r.topic}
                meta={r.claimedAt ? `for ${fmtElapsed(now - r.claimedAt.getTime())}` : 'claimed'}
                programId={r.programId}
              />
            ))}
          </Lane>
          <Lane title="Recently finished" count={buildDone.length}>
            {buildDone.map((r) => (
              <Item
                key={r.id}
                topic={r.topic}
                meta={`built ${r.claimedAt ? fmtElapsed(r.updatedAt.getTime() - r.claimedAt.getTime()) + ' · ' : ''}${fmtWhen(r.updatedAt)}`}
                href={r.trackId ? `/playground/tracks/${r.trackId}` : undefined}
                programId={r.programId}
              />
            ))}
          </Lane>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Remediation queue (RemediationJob)</h2>
        <div className="grid gap-6 md:grid-cols-3">
          <Lane title="Pending" count={remPending.length} capped={remPending.length === ACTIVE_CAP}>
            {remPending.map((j) => (
              <Item
                key={j.id}
                topic={j.path.topic}
                meta={`${j.holeSlugs.length} holes · waiting ${fmtElapsed(now - j.createdAt.getTime())}`}
              />
            ))}
          </Lane>
          <Lane title="Running" count={remRunning.length} capped={remRunning.length === ACTIVE_CAP}>
            {remRunning.map((j) => (
              <Item
                key={j.id}
                topic={j.path.topic}
                meta={`${j.holeSlugs.length} holes · ${j.claimedAt ? `for ${fmtElapsed(now - j.claimedAt.getTime())}` : 'claimed'}`}
              />
            ))}
          </Lane>
          <Lane title="Recently finished" count={remDone.length}>
            {remDone.map((j) => (
              <Item
                key={j.id}
                topic={j.path.topic}
                meta={`${j.holeSlugs.length} holes · ${fmtWhen(j.updatedAt)}`}
              />
            ))}
          </Lane>
        </div>
      </section>
    </main>
  );
}
