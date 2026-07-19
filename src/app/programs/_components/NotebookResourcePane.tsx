'use client';

// Frontend redesign Block 5: the notebook resource renderer — same delivery
// logic as the old /learn ResourcePane (shared helpers in @/lib/resource-embed),
// re-dressed in the notebook language:
//   - embed  → the mock's "taped screen": white-framed iframe with a tape
//              strip; the blocked-embed escape hatch stays (script caption).
//   - generated (resource.content) → a "printed handout" card: sans .lesson-prose
//     markdown on a white card, taped onto the sheet (long-form Kalam is rough).
//   - newtab / native → an open-in-new-tab card in the index-card style (the
//     curation chose newtab because the site blocks framing — don't force it).
// Unlike the old pane (first resource = main, rest listed), EVERY core
// (role=primary) resource gets its full-size treatment, in allocator order;
// only alternates go under "More resources", as bordered rows.

import type { TrackResourceView } from '@/lib/track-view';
import { hostOf, resourceTypeKind, toEmbedSrc } from '@/lib/resource-embed';
import { Markdown } from '@/app/learn/_components/Markdown';
import { EmbedIcon, LinkIcon, PlayIcon } from '@/app/learn/_components/icons';
import type { LessonTypeKind } from '@/lib/course-home-model';
import type { VoteValue } from '@/lib/rating-db';
import { RatingButtons } from './RatingButtons';

// Free-beta A2: the viewer's own votes, keyed by Resource id (NOT LessonResource
// id — ratings are resource-global). Hydrated server-side by the lesson page.
export type MyVotes = Record<string, VoteValue>;

// Every rendering (core card, alternate row) of the same resource shares one
// vote — the thumbs pair reads its initial state from the map.
function voteOf(myVotes: MyVotes, r: TrackResourceView): VoteValue | null {
  return myVotes[r.resource.id] ?? null;
}

export function TypeIcon({ type, size = 16 }: { type: LessonTypeKind; size?: number }) {
  if (type === 'video') return <PlayIcon size={size} />;
  if (type === 'embed') return <EmbedIcon size={size} />;
  return <LinkIcon size={size} />;
}

// The translucent washi-tape strip (same recipe as StickyNote's, centered).
function Tape() {
  return (
    <div
      className="absolute -top-3 left-1/2 z-10 h-6 w-[120px] -translate-x-1/2 rotate-[1.5deg] border"
      style={{ background: 'rgba(120,185,175,.5)', borderColor: 'rgba(120,185,175,.45)' }}
    />
  );
}

export function NotebookResourcePane({
  resources,
  myVotes = {},
}: {
  resources: TrackResourceView[];
  myVotes?: MyVotes;
}) {
  // Cores each render full-size; alternates list below. Defensive: if a lesson
  // somehow has no primary row, promote the first resource so something plays.
  let cores = resources.filter((r) => r.role === 'primary');
  let alternates = resources.filter((r) => r.role !== 'primary');
  if (cores.length === 0 && resources.length > 0) {
    cores = [resources[0]];
    alternates = resources.slice(1);
  }

  if (cores.length === 0) {
    return (
      <div className="flex aspect-[16/9] items-center justify-center rounded-[3px] border-2 border-dashed border-rule font-script text-sm text-script-dim">
        no resource attached yet
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-7">
        {cores.map((r) =>
          r.resource.content != null ? (
            <Handout key={r.id} resource={r} vote={voteOf(myVotes, r)} />
          ) : r.deliveryMode === 'embed' ? (
            <TapedPlayer key={r.id} resource={r} vote={voteOf(myVotes, r)} />
          ) : (
            <OpenCard key={r.id} resource={r} vote={voteOf(myVotes, r)} />
          )
        )}
      </div>
      {alternates.length > 0 && <OtherResources resources={alternates} myVotes={myVotes} />}
    </div>
  );
}

type CoreProps = { resource: TrackResourceView; vote: VoteValue | null };

function TapedPlayer({ resource, vote }: CoreProps) {
  const { url, title } = resource.resource;
  const src = toEmbedSrc(resource);
  // 16:9 for actual video; the taller 16:10 better suits embedded articles/widgets.
  const isVideo = resource.resource.type === 'video' || src.includes('/embed/');
  return (
    <figure className="relative m-0">
      <Tape />
      <iframe
        src={src}
        title={title}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className={`block w-full rounded-md border-[6px] border-card bg-card shadow-[0_10px_26px_rgba(0,0,0,.3)] ${
          isVideo ? 'aspect-video' : 'aspect-[16/10]'
        }`}
      />
      <figcaption className="mt-2 flex items-center gap-3 font-script text-xs text-script-faint">
        <span className="min-w-0 flex-1">
          {hostOf(url)} — some sites block embedding; if this stays blank,{' '}
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-pen">
            open it in a new tab ↗
          </a>
        </span>
        <RatingButtons resourceId={resource.resource.id} initial={vote} />
      </figcaption>
    </figure>
  );
}

// A generated lesson body: printed page taped into the notebook. font-sans +
// .lesson-prose keep the long-form typography of the old design on purpose.
function Handout({ resource, vote }: CoreProps) {
  const { title, content } = resource.resource;
  return (
    <article className="relative rounded-[3px] border border-note-edge bg-card p-6 shadow-[0_6px_14px_rgba(0,0,0,.1)] sm:p-8">
      <Tape />
      <div className="mb-3 flex items-center justify-between gap-3 font-script text-2xs uppercase tracking-[1px] text-script-dim">
        <span>printed handout</span>
        <RatingButtons resourceId={resource.resource.id} initial={vote} />
      </div>
      <div className="font-sans">
        <h2 className="mb-4 text-2xl font-bold tracking-[-0.5px] text-ink">{title}</h2>
        <Markdown content={content ?? ''} />
      </div>
    </article>
  );
}

function OpenCard({ resource, vote }: CoreProps) {
  const { url, title, type } = resource.resource;
  const kind = resourceTypeKind(resource);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="relative flex -rotate-[0.4deg] items-center gap-3.5 rounded-[3px] border border-note-edge bg-card px-[18px] py-[13px] no-underline shadow-[0_4px_10px_rgba(0,0,0,.08)]"
      style={{ borderLeft: '5px solid var(--color-pen)' }}
    >
      <span className="inline-flex h-10 w-10 flex-none -rotate-3 items-center justify-center rounded-[9px_11px_10px_12px] border-2 border-pen text-pen">
        <TypeIcon type={kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-script text-2xs uppercase tracking-[1px] text-script-dim">
          {type} · {hostOf(url)}
        </div>
        <div className="truncate font-hand text-[24px] font-bold leading-none text-script">{title}</div>
      </div>
      {/* Sits inside the card's <a>; RatingButtons preventDefault/stopPropagation
          keep a vote from following the link. */}
      <RatingButtons resourceId={resource.resource.id} initial={vote} />
      <span className="btn-ink flex-none px-4 py-1 text-[19px]">Open ↗</span>
    </a>
  );
}

function OtherResources({ resources, myVotes }: { resources: TrackResourceView[]; myVotes: MyVotes }) {
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-baseline gap-2.5">
        <span className="font-hand text-[24px] font-bold text-script">More resources</span>
        <span className="font-script text-2xs text-script-dim">— optional alternates</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {resources.map((r) => (
          <li
            key={r.id}
            className="max-w-[640px] rounded-[3px] border-2 border-dashed border-rule bg-card px-3.5"
          >
            {r.resource.content != null ? (
              <GeneratedAlternate resource={r} vote={voteOf(myVotes, r)} />
            ) : (
              <ExternalAlternate resource={r} vote={voteOf(myVotes, r)} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AlternateLabel({ r }: { r: TrackResourceView }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate font-script text-sm text-script-body">{r.resource.title}</div>
      {/* the list is alternates-only now — the meta line just says where it lives */}
      <div className="font-script text-2xs text-script-dim">
        {r.resource.content != null ? 'generated lesson' : hostOf(r.resource.url)}
      </div>
    </div>
  );
}

function ExternalAlternate({ resource: r, vote }: { resource: TrackResourceView; vote: VoteValue | null }) {
  return (
    <a
      href={r.resource.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 py-2.5 no-underline"
    >
      <span className="flex-none text-pen">
        <TypeIcon type={resourceTypeKind(r)} size={15} />
      </span>
      <AlternateLabel r={r} />
      <RatingButtons resourceId={r.resource.id} initial={vote} />
      <span className="flex-none font-hand text-[19px] font-bold text-pen">Open ↗</span>
    </a>
  );
}

// A generated alternate has no external page — it expands inline as a handout.
function GeneratedAlternate({ resource: r, vote }: { resource: TrackResourceView; vote: VoteValue | null }) {
  return (
    <details className="group [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-2.5">
        <span className="flex-none text-pen">
          <LinkIcon size={15} />
        </span>
        <AlternateLabel r={r} />
        <RatingButtons resourceId={r.resource.id} initial={vote} />
        <span className="flex-none font-hand text-[19px] font-bold text-pen group-open:hidden">Read ↓</span>
        <span className="hidden flex-none font-hand text-[19px] font-bold text-pen group-open:inline">Hide ↑</span>
      </summary>
      <div className="mb-3 rounded-[3px] border border-note-edge bg-card p-5 font-sans shadow-[0_4px_10px_rgba(0,0,0,.08)]">
        <Markdown content={r.resource.content ?? ''} />
      </div>
    </details>
  );
}
