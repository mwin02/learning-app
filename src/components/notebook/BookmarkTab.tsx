'use client';

// Notebook UI (Block B, extended in Block 3): the bookmark-tab rail — the
// program sidebar of the redesign. One tab per course (track). A tab expands
// to its lesson list (the accordion): route-driven by default (the course
// you're in opens), user-collapsible at the course level via the chevron, and
// grouped by section with per-section collapse when the course has sections.
// Presentational: the parent owns active/expanded state and supplies hrefs.

import { useState } from 'react';
import Link from 'next/link';

export type TabLessonState = 'done' | 'current' | 'todo';
// `current` (the lesson the route is on) is independent of completion state —
// a completed lesson can be the one you're viewing. `state: 'current'` is the
// legacy shorthand for current-and-incomplete.
export type TabLesson = {
  id?: string;
  title: string;
  state: TabLessonState;
  current?: boolean;
  href?: string;
};
export type TabSection = { id: string; title: string; lessons: TabLesson[] };

// A rendered bookmark entry, independent of which navigation draws it: the
// desktop rail stacks these as vertical tabs, the phone strip lays them out as
// a scrolling row of chips with one expanding panel. Built by buildRailTabs in
// program-ui, so the two navigations can never drift on what a course's kicker,
// fraction, accent or lesson state says.
export type RailTab = {
  key: string;
  trackId: string | null;
  kicker: string;
  label: string;
  meta: string;
  bg: string;
  active: boolean;
  href?: string;
  sections?: TabSection[];
  lessons?: TabLesson[];
};

const MARK: Record<TabLessonState, string> = { done: '✓', current: '◉', todo: '○' };
const OPACITY: Record<TabLessonState, string> = { done: '0.9', current: '1', todo: '0.75' };

const isCurrent = (l: TabLesson) => Boolean(l.current) || l.state === 'current';

export function BookmarkRail({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-[26px] z-0 hidden w-[268px] flex-none flex-col gap-[13px] pt-[118px] lg:flex">
      {children}
    </div>
  );
}

function LessonRow({ lesson }: { lesson: TabLesson }) {
  const current = isCurrent(lesson);
  // The row you're on gets the notebook's highlighter: dark ink on a yellow
  // swipe — visible whatever the completion mark says (a bare ◉ can't cover
  // the completed-lesson case, where the mark stays ✓).
  const mark = current && lesson.state !== 'done' ? '◉' : MARK[lesson.state];
  const inner = (
    <>
      <span className="w-3.5 flex-none text-center">{mark}</span>
      <span
        className={current ? 'flex-1 rounded-[2px] px-1 font-bold' : 'flex-1'}
        // The highlighter is a fixed yellow swipe, so its ink must be a fixed
        // dark too — `text-script` flips to near-white in dark mode and vanishes
        // on the yellow. The tokens are theme-fixed (not in the dark block).
        style={
          current
            ? { background: 'rgb(var(--nb-highlighter) / .9)', color: 'var(--nb-highlighter-ink)' }
            : undefined
        }
      >
        {lesson.title}
      </span>
    </>
  );
  const rowClass = 'flex items-center gap-1.5 font-script text-[13.5px] leading-[1.25]';
  return lesson.href ? (
    <Link
      href={lesson.href}
      className={`${rowClass} text-on-accent no-underline hover:underline`}
      style={{ opacity: current ? 1 : OPACITY[lesson.state] }}
      aria-current={current ? 'page' : undefined}
    >
      {inner}
    </Link>
  ) : (
    <div className={rowClass} style={{ opacity: current ? 1 : OPACITY[lesson.state] }}>
      {inner}
    </div>
  );
}

// One collapsible section group inside an expanded tab. Open state is derived:
// the section defaults open when it holds the current lesson, closed otherwise —
// but a manual toggle wins, so the current section can still be collapsed (a
// bare `hasCurrent ||` pinned it open and made its chevron a no-op).
function SectionGroup({ section }: { section: TabSection }) {
  const hasCurrent = section.lessons.some(isCurrent);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? hasCurrent;
  const done = section.lessons.filter((l) => l.state === 'done').length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left font-script text-[12.5px] text-on-accent"
      >
        <span className="w-3.5 flex-none text-center text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="flex-1 truncate font-bold uppercase tracking-[0.5px] opacity-85">
          {section.title}
        </span>
        <span className="flex-none opacity-75">
          {done}/{section.lessons.length}
        </span>
      </button>
      {open && (
        <div className="mb-1 mt-1 flex flex-col gap-1 pl-3.5">
          {section.lessons.map((l) => (
            <LessonRow key={l.id ?? l.title} lesson={l} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BookmarkTab({
  kicker,
  label,
  meta,
  bg,
  active = false,
  href,
  onClick,
  lessons,
  sections,
  expanded,
  onToggleExpand,
}: {
  kicker: string; // e.g. "Course 2 · 1/4"
  label: string;
  meta?: string;
  bg: string; // accent fill (CSS color)
  active?: boolean;
  href?: string;
  onClick?: () => void;
  lessons?: TabLesson[]; // flat lesson list (un-sectioned course)
  sections?: TabSection[]; // sectioned lesson list (wins over `lessons`)
  // Course-level collapse: controlled by the parent when provided; falls back
  // to "expanded while active".
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const hasContent = Boolean(sections?.length || lessons?.length);
  const isExpanded = hasContent && (expanded ?? active);

  const headerText = (
    <>
      <div className="font-script text-[11.5px] uppercase tracking-[1px] opacity-75">{kicker}</div>
      <div className="mt-px font-hand text-[24px] font-bold leading-[1.05]">{label}</div>
      {meta && <div className="mt-0.5 font-script text-[12.5px] opacity-80">{meta}</div>}
    </>
  );

  const className = `relative -mr-4 block w-full rounded-[11px_4px_4px_11px] py-[11px] pl-[15px] pr-[22px] text-left text-on-accent transition-all duration-[130ms] ${
    active
      ? '-ml-5 translate-x-0 shadow-[-6px_6px_15px_rgba(0,0,0,.28)]'
      : 'translate-x-0 shadow-[-2px_3px_8px_rgba(0,0,0,.14)] hover:-translate-x-2 hover:shadow-[-5px_5px_13px_rgba(0,0,0,.22)] hover:brightness-[1.06]'
  }`;

  // Tabs with expandable content (or a collapse control) render as a container
  // div — their header link and lesson rows are separate anchors (nested
  // anchors are invalid HTML).
  if (hasContent || onToggleExpand) {
    return (
      <div className={className} style={{ background: bg }}>
        <div className="flex items-start gap-1">
          {href ? (
            <Link
              href={href}
              className="min-w-0 flex-1 text-on-accent no-underline"
              aria-current={active ? 'true' : undefined}
            >
              {headerText}
            </Link>
          ) : onClick ? (
            <button
              type="button"
              onClick={onClick}
              className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-on-accent"
              aria-pressed={active}
            >
              {headerText}
            </button>
          ) : (
            <div className="min-w-0 flex-1">{headerText}</div>
          )}
          {onToggleExpand && hasContent && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? `Collapse ${label}` : `Expand ${label}`}
              className="-mr-1.5 flex h-6 w-6 flex-none cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[11px] text-on-accent opacity-80 hover:opacity-100"
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          )}
        </div>
        {isExpanded && (
          <div className="mt-[7px] flex flex-col gap-1.5">
            {sections?.length
              ? sections.map((s) => <SectionGroup key={s.id} section={s} />)
              : lessons?.map((l) => <LessonRow key={l.id ?? l.title} lesson={l} />)}
          </div>
        )}
      </div>
    );
  }

  if (href) {
    return (
      <Link href={href} className={`${className} no-underline`} style={{ background: bg }} aria-current={active ? 'true' : undefined}>
        {headerText}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${className} cursor-pointer border-0`} style={{ background: bg }} aria-pressed={active}>
        {headerText}
      </button>
    );
  }
  // Neither href nor onClick: an inert slot (e.g. a course still building).
  return (
    <div className={`${className} opacity-75`} style={{ background: bg }}>
      {headerText}
    </div>
  );
}

// The phone replacement for the rail (its complement: `lg:hidden` against the
// rail's `lg:flex`). A 268px column costs 71% of a 375px viewport, so the tabs
// become a horizontally scrolling row of chips; tapping a course opens its
// lesson list in a panel underneath rather than a drawer, which keeps the
// whole navigation in normal flow — no portal, focus trap, or scroll lock.
//
// `routeKey` closes the panel on navigation: tapping a lesson should reveal it,
// not leave the list covering it. Reconciled at render (react.dev "adjusting
// state when props change"), matching ProgramShell's rail-collapse handling.
export function BookmarkStrip({ tabs, routeKey }: { tabs: RailTab[]; routeKey: string }) {
  const [open, setOpen] = useState<{ forRoute: string; key: string | null }>({
    forRoute: routeKey,
    key: null,
  });
  if (open.forRoute !== routeKey) setOpen({ forRoute: routeKey, key: null });
  const openKey = open.forRoute === routeKey ? open.key : null;
  const panel = tabs.find((t) => t.key === openKey) ?? null;

  return (
    <div className="lg:hidden">
      <div className="no-scrollbar -mx-1 flex gap-2.5 overflow-x-auto px-1 pb-3.5 pt-3">
        {tabs.map((tab) => (
          <StripChip
            key={tab.key}
            tab={tab}
            open={tab.key === openKey}
            onToggle={() => setOpen({ forRoute: routeKey, key: tab.key === openKey ? null : tab.key })}
          />
        ))}
      </div>
      {panel && (
        <div
          className="mb-3.5 rounded-[11px_4px_11px_4px] px-4 pb-3.5 pt-3 text-on-accent shadow-[0_4px_12px_rgba(0,0,0,.2)]"
          style={{ background: panel.bg }}
        >
          {panel.href && (
            <Link
              href={panel.href}
              className="mb-2 block font-script text-[12.5px] text-on-accent underline opacity-85"
            >
              Go to {panel.label} →
            </Link>
          )}
          <div className="flex flex-col gap-1.5">
            {panel.sections?.length
              ? panel.sections.map((s) => <SectionGroup key={s.id} section={s} />)
              : panel.lessons?.map((l) => <LessonRow key={l.id ?? l.title} lesson={l} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// A chip is a toggle when the course has lessons to reveal, and a plain link
// otherwise (the program overview, and courses still building have neither a
// list nor — while unready — a destination).
function StripChip({ tab, open, onToggle }: { tab: RailTab; open: boolean; onToggle: () => void }) {
  const hasContent = Boolean(tab.sections?.length || tab.lessons?.length);
  const className =
    'min-h-[46px] min-w-[132px] max-w-[210px] flex-none rounded-[11px_4px_11px_4px] px-[13px] pb-[9px] pt-2 text-left text-on-accent no-underline';
  const style = {
    background: tab.bg,
    boxShadow: tab.active ? '0 5px 12px rgba(0,0,0,.24)' : '0 3px 8px rgba(0,0,0,.14)',
    opacity: tab.href || hasContent ? 1 : 0.75,
  };
  const inner = (
    <>
      <div className="font-script text-[9.5px] uppercase tracking-[1px] opacity-80">{tab.kicker}</div>
      <div className="mt-px flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-hand text-[19px] font-bold leading-[1.05]">
          {tab.label}
        </span>
        {hasContent && <span className="flex-none text-[10px] opacity-80">{open ? '▾' : '▸'}</span>}
      </div>
    </>
  );

  if (hasContent) {
    return (
      <button type="button" onClick={onToggle} className={className} style={style} aria-expanded={open}>
        {inner}
      </button>
    );
  }
  if (tab.href) {
    return (
      <Link href={tab.href} className={className} style={style} aria-current={tab.active ? 'true' : undefined}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={className} style={style}>
      {inner}
    </div>
  );
}
