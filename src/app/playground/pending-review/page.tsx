import Link from 'next/link';
import type { DurationSource } from '@prisma/client';
import { requireAdminPage } from '@/lib/auth/viewer';
import {
  listPendingReview,
  type PendingReviewRoot,
  type PendingReviewChild,
  type FilingProvenance,
} from '@/lib/curation/pending-review';
import { durationLabel, filingLabel } from '@/lib/curation/pending-review-view';
import { ReviewActions } from './review-actions';
import { RowCorrections } from './row-corrections';
import { CONTAINER_BUTTONS, ROW_BUTTONS, DECOMPOSE_BUTTON } from './buttons';

export const dynamic = 'force-dynamic';

// The status-approval queue: resources discovered by the web fallback land as
// `pending_review` — usable in the run that found them, but hidden from future
// runs once the topic library fills up (PENDING_REVIEW_GATE). Approving lifts
// that gate; rejecting deprecates the row and pulls it from any path it leaked
// into. This is a DIFFERENT axis from Decomposition review (which curates a resource's
// container/atomic shape) — a row can be queued on both.

// Q9: the provenance strip. A reviewer approving a row is signing off on its
// properties, so which of them nobody verified has to be visible rather than
// inferred from the number. `unverified` is a nudge, never a gate — it changes
// the colour and nothing else, and a row can be approved reading `unknown`.
function Provenance({
  durationMin,
  durationSource,
  filing,
}: {
  durationMin: number | null;
  durationSource: DurationSource;
  filing: FilingProvenance | null;
}) {
  const labels = [durationLabel(durationMin, durationSource), filingLabel(filing)];
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {labels.map((l) => (
        <span
          key={l.text}
          className={`rounded px-1 text-xs ${
            l.unverified ? 'bg-amber-50 text-amber-800' : 'bg-gray-100 text-gray-600'
          }`}
        >
          {l.text}
        </span>
      ))}
    </div>
  );
}

// The correction pair travels with the provenance it corrects, on roots and
// children alike — a child is exactly where a wrong 20-minute placeholder lives.
function RowProvenance({ row }: { row: PendingReviewRoot | PendingReviewChild }) {
  return (
    <>
      <Provenance
        durationMin={row.durationMin}
        durationSource={row.durationSource}
        filing={row.filing}
      />
      <RowCorrections
        resourceId={row.id}
        currentTopic={row.filing?.topic ?? null}
        currentDurationMin={row.durationMin}
      />
    </>
  );
}

function ResourceMeta({ root }: { root: PendingReviewRoot }) {
  return (
    <>
      <div className="mt-1 text-gray-600">
        <span>{root.topic}</span>
        {' · '}
        <span>{root.type}</span>
        {' · '}
        <span>{root.origin}</span>
        {' · '}
        <span className="text-blue-700">{root.decompositionStatus}</span>
      </div>
      <div className="mt-1 truncate text-xs text-gray-400">
        <a href={root.url} target="_blank" rel="noreferrer" className="underline">
          {root.url}
        </a>
      </div>
      {/* `root.topic` above is the denormalized mirror; the filing chip below is
          the membership it mirrors. Showing both means mirror drift reads as two
          disagreeing topics instead of hiding behind one of them. */}
      <RowProvenance row={root} />
    </>
  );
}

// Collapsed by default — a container can hold dozens of children (a big doc
// guide, a course path), so keep the queue scannable. Native <details> so the
// page stays a server component (no client JS for the toggle).
function ChildList({ items }: { items: PendingReviewRoot['children'] }) {
  const approved = items.filter((c) => c.status === 'active').length;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-gray-600 select-none">
        {items.length} {items.length === 1 ? 'child' : 'children'}
        {approved > 0 && ` · ${approved} approved`}
      </summary>
      <ul className="mt-2 flex flex-col gap-2 border-l-2 border-gray-100 pl-3">
        {items.map((c) => (
        <li key={c.id} className="text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{c.title}</span>
            <span className="text-xs text-gray-500">
              {c.type} · {c.decompositionStatus}
            </span>
            {c.status === 'active' && (
              <span className="rounded bg-green-50 px-1 text-xs text-green-700">approved</span>
            )}
          </div>
          <div className="truncate text-xs text-gray-400">
            <a href={c.url} target="_blank" rel="noreferrer" className="underline">
              {c.url}
            </a>
          </div>
          <RowProvenance row={c} />
          {/* Per-child approve/reject (cascade=false). A child shown as
              `approved` (active) keeps a Reject button so a later-found-broken
              child can be pulled from existing paths. An atomic child also gets
              "Send to decompose" — a misclassified leaf (a nested TOC page)
              re-routes to the decomposition queue instead of being approved. */}
          <ReviewActions
            resourceId={c.id}
            buttons={
              c.decompositionStatus === 'atomic' ? [...ROW_BUTTONS, DECOMPOSE_BUTTON] : ROW_BUTTONS
            }
          />
        </li>
        ))}
      </ul>
    </details>
  );
}

function QueueList({ roots }: { roots: PendingReviewRoot[] }) {
  if (roots.length === 0) return <p className="text-sm text-gray-600">Nothing here.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {roots.map((root) => {
        const isContainer = root.children.length > 0;
        return (
          <li key={root.id} className="rounded border p-3 text-sm">
            <Link href={`/playground/resource/${root.id}`} className="font-medium underline">
              {root.title}
            </Link>
            <ResourceMeta root={root} />
            {/* A container approves/rejects its whole subtree; an atomic
                resource acts on itself and can also be re-routed to the
                decomposition queue ("Send to decompose") when it's really an
                undecomposed container — a course TOC, a whole book. */}
            <ReviewActions
              resourceId={root.id}
              buttons={
                isContainer
                  ? CONTAINER_BUTTONS
                  : root.decompositionStatus === 'atomic'
                    ? [...ROW_BUTTONS, DECOMPOSE_BUTTON]
                    : ROW_BUTTONS
              }
            />
            {isContainer && <ChildList items={root.children} />}
          </li>
        );
      })}
    </ul>
  );
}

function BlockedList({ roots }: { roots: PendingReviewRoot[] }) {
  if (roots.length === 0) return <p className="text-sm text-gray-600">Nothing here.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {roots.map((root) => (
        <li key={root.id} className="rounded border border-dashed p-3 text-sm">
          <Link href={`/playground/resource/${root.id}`} className="font-medium underline">
            {root.title}
          </Link>
          <ResourceMeta root={root} />
          <p className="mt-2 text-xs text-gray-500">
            Decomposition is <code>{root.decompositionStatus}</code> — resolve it in{' '}
            <Link href="/playground/decomposition-review" className="underline">
              Decomposition review
            </Link>{' '}
            before approving.
          </p>
        </li>
      ))}
    </ul>
  );
}

export default async function PendingReviewPage() {
  await requireAdminPage();

  const queue = await listPendingReview();
  const blocked = queue.filter((r) => r.blocked);
  const actionable = queue.filter((r) => !r.blocked);

  return (
    <main className="flex flex-col gap-6 p-6">
      <section>
        <h1 className="mb-2 text-2xl font-bold">Pending review</h1>
        <p className="max-w-2xl text-sm text-gray-600">
          Resources discovered by the web fallback land as <code>pending_review</code>: usable in
          the run that found them, but hidden from future runs once the topic library fills up.{' '}
          <strong>Approve</strong> lifts that gate (→ <code>active</code>). <strong>Reject</strong>{' '}
          deprecates the resource and drops it from any path it already appears in. For a container,{' '}
          <strong>Approve all / Reject all</strong> applies to the whole subtree; use the per-child
          buttons to act on a single lesson. <strong>Send to decompose</strong> re-routes a
          misclassified atomic row (really a container — a course TOC, a whole book) to the
          decomposition queue instead of deciding it here.
        </p>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">
          Each row carries two <strong>provenance</strong> chips: its duration with the source
          that produced it, and its primary topic membership with the origin that filed it. An{' '}
          <span className="rounded bg-amber-50 px-1 text-amber-800">amber</span> chip means nobody
          verified that value — an <code>estimated</code> or <code>unknown</code> duration, an{' '}
          <code>inherited</code> or <code>discovery</code> filing, a contested membership. You have
          the page open, which is the one place the true numbers are free:{' '}
          <strong>Correct duration / topic</strong> records a duration as{' '}
          <code>reviewer</code>-measured and refiles the topic through the membership seam.{' '}
          <strong>None of this blocks approval</strong> — an interactive with no measurable
          duration is meant to be approved reading <code>unknown</code>.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-xl font-semibold">
          Awaiting approval <span className="font-normal text-gray-500">({actionable.length})</span>
        </h2>
        <QueueList roots={actionable} />
      </section>

      <section>
        <h2 className="mb-2 text-xl font-semibold">
          Blocked on decomposition{' '}
          <span className="font-normal text-gray-500">({blocked.length})</span>
        </h2>
        <BlockedList roots={blocked} />
      </section>
    </main>
  );
}
