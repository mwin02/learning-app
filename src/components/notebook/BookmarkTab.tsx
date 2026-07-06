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

const MARK: Record<TabLessonState, string> = { done: '✓', current: '◉', todo: '○' };
const OPACITY: Record<TabLessonState, string> = { done: '0.9', current: '1', todo: '0.75' };

const isCurrent = (l: TabLesson) => Boolean(l.current) || l.state === 'current';

export function BookmarkRail({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-[26px] z-0 flex w-[220px] flex-none flex-col gap-[13px] pt-[118px]">
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
        className={current ? 'flex-1 rounded-[2px] px-1 font-bold text-script' : 'flex-1'}
        style={current ? { background: 'rgba(255,224,102,.9)' } : undefined}
      >
        {lesson.title}
      </span>
    </>
  );
  const rowClass = 'flex items-center gap-1.5 font-script text-[11.5px] leading-[1.2]';
  return lesson.href ? (
    <Link
      href={lesson.href}
      className={`${rowClass} text-white no-underline hover:underline`}
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
// the section holding the current lesson is always open; a manual toggle
// overrides the default (closed) for the rest.
function SectionGroup({ section }: { section: TabSection }) {
  const hasCurrent = section.lessons.some(isCurrent);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = hasCurrent || (manualOpen ?? false);
  const done = section.lessons.filter((l) => l.state === 'done').length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left font-script text-[11px] text-white"
      >
        <span className="w-3.5 flex-none text-center text-[9px]">{open ? '▾' : '▸'}</span>
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
      <div className="font-script text-[10px] uppercase tracking-[1px] opacity-75">{kicker}</div>
      <div className="mt-px font-hand text-[20px] font-bold leading-[1.05]">{label}</div>
      {meta && <div className="mt-0.5 font-script text-[11px] opacity-80">{meta}</div>}
    </>
  );

  const className = `relative -mr-4 block w-full rounded-[11px_4px_4px_11px] py-[11px] pl-[15px] pr-[22px] text-left text-white transition-transform duration-[130ms] hover:translate-x-0 ${
    active
      ? '-translate-x-3.5 shadow-[-4px_5px_12px_rgba(0,0,0,.22)]'
      : 'translate-x-0 shadow-[-2px_3px_8px_rgba(0,0,0,.14)]'
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
              className="min-w-0 flex-1 text-white no-underline"
              aria-current={active ? 'true' : undefined}
            >
              {headerText}
            </Link>
          ) : onClick ? (
            <button
              type="button"
              onClick={onClick}
              className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-white"
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
              className="-mr-1.5 flex h-6 w-6 flex-none cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[11px] text-white opacity-80 hover:opacity-100"
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
