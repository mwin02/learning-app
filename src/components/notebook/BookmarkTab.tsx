// Notebook UI (Block B): the bookmark-tab rail — the program sidebar of the
// redesign. One tab per course (track); the active tab slides out and, per the
// accordion decision, expands to list its lessons inline. Presentational: the
// parent owns active state and supplies hrefs (Link) or an onClick.

import Link from 'next/link';

export type TabLessonState = 'done' | 'current' | 'todo';
export type TabLesson = { title: string; state: TabLessonState };

const MARK: Record<TabLessonState, string> = { done: '✓', current: '◉', todo: '○' };
const OPACITY: Record<TabLessonState, string> = { done: '0.9', current: '1', todo: '0.75' };

export function BookmarkRail({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-[26px] z-0 flex w-[150px] flex-none flex-col gap-[13px] pt-[118px]">
      {children}
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
}: {
  kicker: string; // e.g. "Course 2 · 1/4"
  label: string;
  meta?: string;
  bg: string; // accent fill (CSS color)
  active?: boolean;
  href?: string;
  onClick?: () => void;
  lessons?: TabLesson[]; // rendered only while active (the accordion)
}) {
  const body = (
    <>
      <div className="font-script text-[10px] uppercase tracking-[1px] opacity-75">{kicker}</div>
      <div className="mt-px font-hand text-[20px] font-bold leading-[1.05]">{label}</div>
      {meta && <div className="mt-0.5 font-script text-[11px] opacity-80">{meta}</div>}
      {active && lessons && lessons.length > 0 && (
        <div className="mt-[7px] flex flex-col gap-1">
          {lessons.map((l) => (
            <div
              key={l.title}
              className="flex items-center gap-1.5 font-script text-[11.5px] leading-[1.15]"
              style={{ opacity: OPACITY[l.state] }}
            >
              <span className="w-3.5 flex-none text-center">{MARK[l.state]}</span>
              <span className="flex-1">{l.title}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const className = `relative -mr-4 block w-full rounded-[11px_4px_4px_11px] py-[11px] pl-[15px] pr-[22px] text-left text-white transition-transform duration-[130ms] hover:translate-x-0 ${
    active
      ? '-translate-x-3.5 shadow-[-4px_5px_12px_rgba(0,0,0,.22)]'
      : 'translate-x-0 shadow-[-2px_3px_8px_rgba(0,0,0,.14)]'
  }`;

  if (href) {
    return (
      <Link href={href} className={`${className} no-underline`} style={{ background: bg }} aria-current={active ? 'true' : undefined}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${className} cursor-pointer border-0`} style={{ background: bg }} aria-pressed={active}>
        {body}
      </button>
    );
  }
  // Neither href nor onClick: an inert slot (e.g. a course still building).
  return (
    <div className={`${className} opacity-75`} style={{ background: bg }}>
      {body}
    </div>
  );
}
