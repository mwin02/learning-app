'use client';

// Lesson View v3: the notebook resource renderer, reshaped around lessons that
// carry SEVERAL mandatory core resources. v2 stacked every core full-size down
// the sheet, which made a three-core lesson read as an undifferentiated pile and
// buried the optional pool under it. v3 splits the two apart:
//
//   - one core at a time on the STAGE (left column), with "Mark viewed" and
//     "Next resource" to walk the set;
//   - the RAIL (right column) lists all cores with their number/✓ state, then —
//     visually separated, dashed, collapsed — the optional pool as clipped-in
//     scraps.
//
// Delivery treatments are unchanged from v2 (shared helpers in
// @/lib/resource-embed): embed → the taped screen; generated (resource.content)
// → a printed handout; newtab/native → an open-in-new-tab card, because the
// curation chose newtab where the site blocks framing — don't force it.
//
// Viewed state is per-lesson localStorage (see resource-viewed-store): a
// within-lesson checklist, NOT a second progress record. Lesson completion
// stays the DB-backed truth.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TrackResourceView } from '@/lib/track-view';
import { hostOf, resourceTypeKind, toEmbedSrc } from '@/lib/resource-embed';
import {
  buildLessonResourcesView,
  coreProgressLine,
  type LessonResourcesView,
} from '@/lib/lesson-resources-view';
import { loadViewed, saveViewed } from '@/lib/resource-viewed-store';
import { Markdown } from '@/app/learn/_components/Markdown';
import { EmbedIcon, LinkIcon, PlayIcon } from '@/app/learn/_components/icons';
import type { LessonTypeKind } from '@/lib/course-home-model';
import type { VoteValue } from '@/lib/rating-db';
import { RatingButtons } from './RatingButtons';
import { ReportDialog } from './ReportDialog';

// Free-beta A2: the viewer's own votes, keyed by Resource id (NOT LessonResource
// id — ratings are resource-global). Hydrated server-side by the lesson page.
export type MyVotes = Record<string, VoteValue>;

// Every rendering (stage, rail, scrap) of the same resource shares one vote —
// the thumbs pair reads its initial state from the map.
function voteOf(myVotes: MyVotes, r: TrackResourceView): VoteValue | null {
  return myVotes[r.resource.id] ?? null;
}

// ---------------------------------------------------------------------------
// shared state
// ---------------------------------------------------------------------------

export type LessonResourcesState = {
  view: LessonResourcesView;
  activeId: string | null;
  active: TrackResourceView | null;
  activeIndex: number;
  select: (id: string) => void;
  isViewed: (id: string) => boolean;
  toggleViewed: (id: string) => void;
  viewedCount: number;
  goNext: () => void;
  hasNext: boolean;
  stageRef: React.RefObject<HTMLDivElement | null>;
  railRef: React.RefObject<HTMLElement | null>;
};

// Switching resources must not move the page out from under the reader. On the
// two-column layout the stage sits BESIDE the rail that was just clicked, so
// there is nothing to reveal and any scroll is pure disruption — the first cut
// used scrollIntoView('start') unconditionally and yanked the page to the
// stage's top on every rail click. Only the stacked layout, where the rail is
// below the stage, needs the scroll. Which layout is live is read off the
// geometry rather than a JS copy of the `lg` breakpoint, so the two can't drift.
function revealStage(stage: HTMLDivElement | null, rail: HTMLElement | null): void {
  if (!stage || !rail) return;
  if (rail.getBoundingClientRect().top < stage.getBoundingClientRect().bottom) return;
  stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// One hook owns the selection + viewed set so the stage and the rail — which the
// lesson view renders in different columns — stay in step without a context.
export function useLessonResources(
  lessonId: string,
  resources: TrackResourceView[],
): LessonResourcesState {
  const view = useMemo(() => buildLessonResourcesView(resources), [resources]);
  const firstId = view.cores[0]?.id ?? null;

  const [activeId, setActiveId] = useState<string | null>(firstId);
  // Empty on the server and on the first client render, then hydrated — same
  // hydration-mismatch dance as CourseProvider's completed set.
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  // Once the learner picks a resource themselves, hydration must not move the
  // stage out from under them.
  const picked = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    loadViewed(lessonId).then((stored) => {
      if (!active) return; // the learner navigated to another lesson mid-read
      setViewed(stored);
      // Resume where they left off: the first core they haven't ticked.
      if (!picked.current) {
        const resume = view.cores.find((r) => !stored.has(r.id));
        if (resume) setActiveId(resume.id);
      }
    });
    return () => {
      active = false;
    };
  }, [lessonId, view]);

  const select = useCallback((id: string) => {
    picked.current = true;
    setActiveId(id);
  }, []);

  const toggleViewed = useCallback(
    (id: string) => {
      setViewed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveViewed(lessonId, next);
        return next;
      });
    },
    [lessonId],
  );

  const activeIndex = view.cores.findIndex((r) => r.id === activeId);
  const hasNext = activeIndex > -1 && activeIndex < view.cores.length - 1;

  const goNext = useCallback(() => {
    if (!hasNext) return;
    select(view.cores[activeIndex + 1].id);
    revealStage(stageRef.current, railRef.current);
  }, [hasNext, select, view.cores, activeIndex]);

  return {
    view,
    activeId,
    active: activeIndex === -1 ? null : view.cores[activeIndex],
    activeIndex,
    select,
    isViewed: (id: string) => viewed.has(id),
    toggleViewed,
    viewedCount: view.cores.filter((r) => viewed.has(r.id)).length,
    goNext,
    hasNext,
    stageRef,
    railRef,
  };
}

// Reports R3: the taste channel (thumbs) and the defect channel (flag) always
// travel together, so every placement renders one element and the two stay
// aligned. `content != null` is track-view's documented marker for an
// origin='generated' row — those have no external URL, which is what lets the
// dialog drop its "Link is broken" option without new data plumbing.
function ResourceActions({
  resource: r,
  vote,
  lessonId,
}: {
  resource: TrackResourceView;
  vote: VoteValue | null;
  lessonId?: string;
}) {
  return (
    <span className="inline-flex flex-none items-center gap-0.5">
      <RatingButtons resourceId={r.resource.id} initial={vote} />
      <ReportDialog
        resourceId={r.resource.id}
        lessonId={lessonId}
        generated={r.resource.content != null}
        resourceTitle={r.resource.title}
      />
    </span>
  );
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

// ---------------------------------------------------------------------------
// the stage — one core resource at a time
// ---------------------------------------------------------------------------

export function ResourceStage({
  state,
  myVotes = {},
  lessonId,
}: {
  state: LessonResourcesState;
  myVotes?: MyVotes;
  // R3: ambient placement context for a report — WHERE the learner hit the
  // resource, so triage can tell a placement defect from a row defect.
  lessonId?: string;
}) {
  const { view, active, activeIndex, isViewed, toggleViewed, goNext, hasNext, stageRef } = state;

  if (!active) {
    return (
      <div className="flex aspect-[16/9] items-center justify-center rounded-[3px] border-2 border-dashed border-rule font-script text-sm text-script-dim">
        no resource attached yet
      </div>
    );
  }

  const vote = voteOf(myVotes, active);
  const viewed = isViewed(active.id);
  // The open-in-new-tab card already carries its title at full size; repeating it
  // in the control row directly underneath just reads as a duplicate.
  const showTitle = active.resource.content != null || active.deliveryMode === 'embed';

  return (
    <div ref={stageRef}>
      {view.cores.length > 1 && (
        <div className="nb-kicker mb-1.5 text-script-dim">
          resource {activeIndex + 1} of {view.cores.length}
        </div>
      )}

      {/* Keyed so switching resources remounts the iframe rather than swapping
          its src underneath a running player. */}
      {active.resource.content != null ? (
        <Handout key={active.id} resource={active} vote={vote} lessonId={lessonId} />
      ) : active.deliveryMode === 'embed' ? (
        <TapedPlayer key={active.id} resource={active} vote={vote} lessonId={lessonId} />
      ) : (
        <OpenCard key={active.id} resource={active} vote={vote} lessonId={lessonId} />
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-3.5">
        {showTitle && (
          <span className="font-hand text-[26px] font-bold leading-tight text-script">
            {active.resource.title}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => toggleViewed(active.id)}
          aria-pressed={viewed}
          className={`rounded-[9px_8px_11px_10px] border-2 border-crayon-green px-3.5 py-0.5 font-hand text-[19px] font-bold ${
            viewed ? 'bg-crayon-green text-on-accent' : 'bg-transparent text-crayon-green'
          }`}
        >
          ✓ {viewed ? 'Viewed' : 'Mark viewed'}
        </button>
        {hasNext && (
          <button
            type="button"
            onClick={goNext}
            className="cursor-pointer font-hand text-[19px] font-bold text-pen"
          >
            Next resource →
          </button>
        )}
      </div>
    </div>
  );
}

type CoreProps = { resource: TrackResourceView; vote: VoteValue | null; lessonId?: string };

function TapedPlayer({ resource, vote, lessonId }: CoreProps) {
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
        <ResourceActions resource={resource} vote={vote} lessonId={lessonId} />
      </figcaption>
    </figure>
  );
}

// A generated lesson body: printed page taped into the notebook. font-sans +
// .lesson-prose keep the long-form typography of the old design on purpose.
function Handout({ resource, vote, lessonId }: CoreProps) {
  const { title, content } = resource.resource;
  return (
    <article className="relative rounded-[3px] border border-note-edge bg-card p-6 shadow-[0_6px_14px_rgba(0,0,0,.1)] sm:p-8">
      <Tape />
      <div className="mb-3 flex items-center justify-between gap-3 font-script text-2xs uppercase tracking-[1px] text-script-dim">
        <span>printed handout</span>
        <ResourceActions resource={resource} vote={vote} lessonId={lessonId} />
      </div>
      <div className="font-sans">
        <h2 className="mb-4 text-2xl font-bold tracking-[-0.5px] text-ink">{title}</h2>
        <Markdown content={content ?? ''} />
      </div>
    </article>
  );
}

function OpenCard({ resource, vote, lessonId }: CoreProps) {
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
      {/* Sits inside the card's <a>; both actions preventDefault/stopPropagation
          (and the report panel portals out of the anchor) so neither follows the
          link. */}
      <ResourceActions resource={resource} vote={vote} lessonId={lessonId} />
      <span className="btn-ink flex-none px-4 py-1 text-[19px]">Open ↗</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// the rail — every core's state, then the optional pool
// ---------------------------------------------------------------------------

export function ResourceRail({
  state,
  myVotes = {},
  lessonId,
}: {
  state: LessonResourcesState;
  myVotes?: MyVotes;
  lessonId?: string;
}) {
  const { view, activeId, select, isViewed, viewedCount, stageRef, railRef } = state;
  if (view.cores.length === 0) return null;

  const onSelect = (id: string) => {
    select(id);
    revealStage(stageRef.current, railRef.current);
  };

  return (
    <aside ref={railRef} className="w-full flex-none lg:w-[300px]">
      <div className="font-hand text-[24px] font-bold text-script">
        {view.cores.length > 1 ? 'Core resources' : 'This resource'}
      </div>
      <div className="mb-2.5 font-script text-2xs text-script-faint">
        {coreProgressLine(viewedCount, view.cores.length)}
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {view.rail.map((row) => (
          <li key={row.id}>
            <RailRow
              row={row}
              active={row.id === activeId}
              viewed={isViewed(row.id)}
              onSelect={() => onSelect(row.id)}
            />
          </li>
        ))}
      </ul>

      {view.optionalSummary && (
        <OptionalPool
          summary={view.optionalSummary}
          resources={view.alternates}
          myVotes={myVotes}
          lessonId={lessonId}
        />
      )}
    </aside>
  );
}

function RailRow({
  row,
  active,
  viewed,
  onSelect,
}: {
  row: LessonResourcesView['rail'][number];
  active: boolean;
  viewed: boolean;
  onSelect: () => void;
}) {
  const badge = viewed
    ? 'bg-crayon-green text-on-accent'
    : active
      ? 'bg-pen text-on-accent'
      : 'border-[1.5px] border-rule-strong text-script-faint';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={`nb-hl-hover w-full cursor-pointer rounded-[8px_10px_9px_11px] px-3.5 py-2.5 text-left ${
        active
          ? 'border-2 border-pen bg-card shadow-[0_3px_8px_rgba(0,0,0,.08)]'
          : 'border-[1.5px] border-rule-strong bg-card/60'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full font-script text-2xs ${badge}`}
        >
          {viewed ? '✓' : row.n}
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-hand text-[21px] font-bold ${
            active ? 'text-script' : 'text-script-body'
          }`}
        >
          {row.title}
        </span>
        {active && <span className="flex-none font-script text-2xs text-pen">now</span>}
        {row.delivery === 'newtab' && (
          <span className="flex-none font-script text-xs text-crayon-red">↗</span>
        )}
      </div>
      <div className="pl-[31px] font-script text-2xs uppercase tracking-[0.8px] text-script-dim">
        {row.meta}
      </div>
    </button>
  );
}

// The optional pool: dashed, collapsed, and unmistakably not part of the core
// set. Expanding it reveals each extra as a clipped-in scrap.
function OptionalPool({
  summary,
  resources,
  myVotes,
  lessonId,
}: {
  summary: string;
  resources: TrackResourceView[];
  myVotes: MyVotes;
  lessonId?: string;
}) {
  return (
    <>
      {/* The heading sits outside <details> — <summary> must be its first child. */}
      <div className="mb-1 mt-[22px] font-hand text-[22px] font-bold text-script-faint">
        Optional — if you want more
      </div>
      <details className="group lg:relative [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-[10px] border-2 border-dashed border-rule-strong bg-card/40 px-3.5 py-2.5">
          <span className="font-script text-2xs text-script-faint">{summary}</span>
          <div className="flex-1" />
          <span className="font-script text-sm text-script-faint group-open:hidden">⌄</span>
          <span className="hidden font-script text-sm text-script-faint group-open:inline">⌃</span>
        </summary>
        {/* Out of flow from `lg` up, where the rail is a column beside the sheet's
            main content: in flow, expanding it grew the rail, which grew the
            two-column row, which pushed the quiz ~500px down the page. Below
            `lg` the rail is stacked last, so pushing costs nothing and static
            keeps the list reachable. */}
        <ul className="m-0 flex list-none flex-col gap-3 p-0 pt-4 lg:absolute lg:inset-x-0 lg:top-full lg:z-20 lg:pt-3">
          {resources.map((r, i) => (
            <li key={r.id}>
              <ClippedScrap rotate={i % 2 === 0 ? 1.2 : -1.4}>
                {r.resource.content != null ? (
                  <GeneratedScrap resource={r} vote={voteOf(myVotes, r)} lessonId={lessonId} />
                ) : (
                  <ExternalScrap resource={r} vote={voteOf(myVotes, r)} lessonId={lessonId} />
                )}
              </ClippedScrap>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

// A scrap of paper clipped into the notebook — the paperclip is the open-ended
// rounded rectangle straddling the top edge.
function ClippedScrap({ rotate, children }: { rotate: number; children: React.ReactNode }) {
  return (
    <div
      className="relative rounded-[2px] border border-note-edge bg-note px-3.5 pb-3 pt-2.5 shadow-[0_4px_10px_rgba(0,0,0,.1)]"
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <div className="absolute -top-2.5 left-4 h-[26px] w-3.5 rounded-[7px] border-[2.5px] border-script-dim" />
      {children}
    </div>
  );
}

function ScrapLabel({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="min-w-0 flex-1 pl-[34px]">
      <div className="font-script text-2xs uppercase tracking-[1px] text-note-label">{kicker}</div>
      <div className="font-hand text-[20px] font-bold leading-tight text-script">{title}</div>
    </div>
  );
}

function ExternalScrap({ resource: r, vote, lessonId }: CoreProps) {
  return (
    <div className="flex items-center gap-2">
      <a
        href={r.resource.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 flex-1 no-underline"
      >
        <ScrapLabel kicker="clipped in · opens elsewhere" title={`${r.resource.title} ↗`} />
      </a>
      <ResourceActions resource={r} vote={vote} lessonId={lessonId} />
    </div>
  );
}

// A generated extra has no external page — it expands inline as a handout.
function GeneratedScrap({ resource: r, vote, lessonId }: CoreProps) {
  return (
    <details className="group/scrap [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <ScrapLabel kicker="clipped in · reads here" title={r.resource.title} />
        <ResourceActions resource={r} vote={vote} lessonId={lessonId} />
        <span className="flex-none font-hand text-[19px] font-bold text-pen group-open/scrap:hidden">
          Read ↓
        </span>
        <span className="hidden flex-none font-hand text-[19px] font-bold text-pen group-open/scrap:inline">
          Hide ↑
        </span>
      </summary>
      <div className="mt-3 rounded-[3px] border border-note-edge bg-card p-4 font-sans shadow-[0_4px_10px_rgba(0,0,0,.08)]">
        <Markdown content={r.resource.content ?? ''} />
      </div>
    </details>
  );
}
