import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { DeprecationSeverity } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';

export const dynamic = 'force-dynamic';

// Phase 2.5g-5b: read-only triage surface for BROKEN TRACKS. Tracks are immutable
// snapshots of a Path (see schema.prisma) — the reject pipeline (2.5g-5) keeps the
// Path accurate but never patches a built Track, so a Track can keep pointing at a
// since-deprecated Resource. This page surfaces exactly those so an operator can
// fix/rebuild them by hand. A "broken" Track = one with ≥1 LessonResource whose
// Resource is now `deprecated`. Filter by the rejection severity (soft/hard).

type Severity = 'all' | DeprecationSeverity;

// Cap the broken-LessonResource scan. This is an internal force-dynamic triage
// page, not a paginated list — the cap keeps a degenerate library (lots of
// deprecated links) from scanning the whole table on every load. If we hit it,
// the page says so; tighten the severity filter to see the rest.
const ROW_CAP = 500;

const SEV_BADGE: Record<DeprecationSeverity, string> = {
  hard: 'bg-red-100 text-red-800',
  soft: 'bg-amber-100 text-amber-900',
};

const TABS: { key: Severity; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'hard', label: 'Hard (dead link)' },
  { key: 'soft', label: 'Soft (quality)' },
];

type BrokenEntry = {
  lessonOrder: number;
  lessonTitle: string;
  role: string;
  resourceTitle: string;
  url: string;
  severity: DeprecationSeverity | null;
};
type BrokenTrack = {
  trackId: string;
  title: string;
  status: string;
  topic: string;
  entries: BrokenEntry[];
  hardCount: number;
  softCount: number;
};

export default async function BrokenTracksPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string }>;
}) {
  if (!isDevAuthEnabled()) notFound();

  const { severity } = await searchParams;
  const active: Severity = severity === 'hard' || severity === 'soft' ? severity : 'all';

  const rows = await prisma.lessonResource.findMany({
    where: {
      resource: {
        status: 'deprecated',
        ...(active === 'all' ? {} : { deprecationSeverity: active }),
      },
    },
    select: {
      role: true,
      lesson: {
        select: {
          title: true,
          orderInTrack: true,
          track: {
            select: { id: true, title: true, status: true, path: { select: { topic: true } } },
          },
        },
      },
      resource: { select: { title: true, url: true, deprecationSeverity: true } },
    },
    orderBy: [{ lesson: { orderInTrack: 'asc' } }],
    take: ROW_CAP,
  });
  const truncated = rows.length === ROW_CAP;

  // Group broken LessonResources by their Track.
  const byTrack = new Map<string, BrokenTrack>();
  for (const r of rows) {
    const t = r.lesson.track;
    let bt = byTrack.get(t.id);
    if (!bt) {
      bt = {
        trackId: t.id,
        title: t.title ?? '(untitled)',
        status: t.status,
        topic: t.path.topic,
        entries: [],
        hardCount: 0,
        softCount: 0,
      };
      byTrack.set(t.id, bt);
    }
    bt.entries.push({
      lessonOrder: r.lesson.orderInTrack,
      lessonTitle: r.lesson.title,
      role: r.role,
      resourceTitle: r.resource.title,
      url: r.resource.url,
      severity: r.resource.deprecationSeverity,
    });
    if (r.resource.deprecationSeverity === 'hard') bt.hardCount++;
    else if (r.resource.deprecationSeverity === 'soft') bt.softCount++;
  }

  // Most-broken first: hard breaks dominate, then soft, then title.
  const tracks = [...byTrack.values()].sort(
    (a, b) => b.hardCount - a.hardCount || b.softCount - a.softCount || a.title.localeCompare(b.title),
  );

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-bold mb-2">Broken tracks</h1>
        <p className="text-sm text-gray-600 max-w-3xl">
          Tracks are <strong>immutable snapshots</strong> of a Path. Rejecting a resource keeps the
          Path accurate (drops it from the candidate pool) but never patches a built Track, so a
          Track can keep pointing at a now-<code>deprecated</code> resource. These are the Tracks
          with ≥1 such resource — triage / rebuild them manually.
        </p>
      </section>

      <nav className="flex gap-2 text-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.key === 'all' ? '/playground/broken-tracks' : `/playground/broken-tracks?severity=${tab.key}`}
            className={`rounded px-3 py-1 border ${
              active === tab.key ? 'bg-black text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {truncated && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Showing the first {ROW_CAP} broken resource links only. Tighten the severity filter to see
          the rest.
        </p>
      )}

      {tracks.length === 0 ? (
        <p className="text-sm text-gray-600">
          No broken tracks{active === 'all' ? '' : ` with ${active} rejections`}. 🎉
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {tracks.map((t) => (
            <li key={t.trackId} className="border rounded p-4 text-sm flex flex-col gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <Link href={`/playground/tracks/${t.trackId}`} className="font-medium underline">
                  {t.title}
                </Link>
                <span className="text-gray-500 text-xs">{t.topic}</span>
                <span className="rounded px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700">
                  {t.status}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {t.hardCount > 0 && (
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEV_BADGE.hard}`}>
                      {t.hardCount} hard
                    </span>
                  )}
                  {t.softCount > 0 && (
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEV_BADGE.soft}`}>
                      {t.softCount} soft
                    </span>
                  )}
                </span>
              </div>
              <ul className="flex flex-col gap-1 pl-1">
                {t.entries.map((e) => (
                  <li key={`${e.lessonOrder}-${e.role}-${e.url}`} className="flex items-baseline gap-2 text-xs">
                    <span className="text-gray-400 w-8 shrink-0 text-right">L{e.lessonOrder}</span>
                    <span className="text-gray-700 shrink-0">{e.lessonTitle}</span>
                    <span className="rounded px-1.5 bg-gray-200 text-gray-700 shrink-0">{e.role}</span>
                    {e.severity && (
                      <span className={`rounded px-1.5 shrink-0 ${SEV_BADGE[e.severity]}`}>{e.severity}</span>
                    )}
                    <a href={e.url} target="_blank" rel="noreferrer" className="text-gray-600 underline break-all">
                      {e.resourceTitle}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
