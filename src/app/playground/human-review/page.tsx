import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { classify } from '@/lib/agents/decomposition/router';

export const dynamic = 'force-dynamic';

// Why a container ended up unpickable, hinted from its URL/type. The exact
// reason (oversize count, JS-rendered, etc.) isn't persisted on the row, but the
// router's classification narrows it: a playlist/doc tree here was either too
// large to auto-decompose or couldn't be parsed; a paywalled platform is never
// crawled.
const KIND_HINT: Record<string, string> = {
  youtube_playlist: 'YouTube playlist — too large to auto-decompose, or unreadable',
  doc_toc: 'doc tree — too many sections to auto-decompose, or no parseable outline',
  unsupported: 'paywalled platform — not crawled',
  atomic: 'classified atomic (no longer a container candidate)',
};

type Row = {
  id: string;
  title: string;
  topic: string;
  type: string;
  url: string;
  origin: string;
  updatedAt: Date;
};

function QueueList({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-600">Nothing here.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => {
        const kind = classify({ url: r.url, type: r.type }).kind;
        return (
          <li key={r.id} className="border rounded p-3 text-sm">
            <Link href={`/playground/resource/${r.id}`} className="font-medium underline">
              {r.title}
            </Link>
            <div className="text-gray-600 mt-1">
              <span>{r.topic}</span>
              {' · '}
              <span>{r.type}</span>
              {' · '}
              <span>{r.origin}</span>
              {' · '}
              <span className="text-blue-700">{kind}</span>
            </div>
            <div className="text-gray-500 text-xs mt-1">{KIND_HINT[kind] ?? kind}</div>
            <div className="text-gray-400 text-xs mt-1 truncate">
              <a href={r.url} target="_blank" rel="noreferrer" className="underline">
                {r.url}
              </a>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default async function HumanReviewPage() {
  if (!isDevAuthEnabled()) notFound();

  // Top-level container rows that aren't pickable: human_review (a human must
  // decide) and pending (a transient/automatic retry — shown for visibility).
  // Children are always atomic, so parentResourceId is null for everything here.
  const rows = await prisma.resource.findMany({
    where: {
      parentResourceId: null,
      decompositionStatus: { in: ['human_review', 'pending'] },
    },
    select: {
      id: true,
      title: true,
      topic: true,
      type: true,
      url: true,
      origin: true,
      updatedAt: true,
      decompositionStatus: true,
    },
    orderBy: [{ topic: 'asc' }, { title: 'asc' }],
  });

  const humanReview = rows.filter((r) => r.decompositionStatus === 'human_review');
  const pending = rows.filter((r) => r.decompositionStatus === 'pending');

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-bold mb-2">Human review</h1>
        <p className="text-sm text-gray-600 max-w-2xl">
          Container resources the decomposition pipeline could not (or chose not to) explode into
          atomic children. They are <strong>not pickable</strong> by the curriculum agent until
          resolved. <code>human_review</code> needs a manual decision (decompose anyway, pick a
          subset, or reject); <code>pending</code> is a transient/automatic retry shown for
          visibility. Curation actions land in a later block — this view makes the queue
          observable.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-2">
          Needs review <span className="text-gray-500 font-normal">({humanReview.length})</span>
        </h2>
        <QueueList rows={humanReview} />
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-2">
          Pending retry <span className="text-gray-500 font-normal">({pending.length})</span>
        </h2>
        <QueueList rows={pending} />
      </section>
    </main>
  );
}
