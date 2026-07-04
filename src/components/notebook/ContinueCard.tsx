// Notebook UI (Block B): the "pick up where you left off" sticky note — play
// circle, next lesson title/meta, and a Resume button. Used by the course
// overview (and later the dashboard's cross-program resume).

import Link from 'next/link';
import { StickyNote } from './primitives';

export function ContinueCard({
  title,
  meta,
  href,
  kicker = '↪ pick up where you left off',
}: {
  title: string;
  meta: string; // e.g. "Section 2 · Lesson 2 · embed · ~12 min"
  href: string;
  kicker?: string;
}) {
  return (
    <StickyNote className="max-w-[560px] px-5 py-4">
      <div className="font-script text-xs uppercase tracking-[1px] text-note-label">{kicker}</div>
      <div className="mt-1.5 flex items-center gap-3.5">
        <div className="flex h-[46px] w-[46px] flex-none items-center justify-center rounded-full border-2 border-pen text-pen">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M7 5l12 7-12 7z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-hand text-[26px] font-bold leading-none text-script">{title}</div>
          <div className="mt-px font-script text-xs text-script-faint">{meta}</div>
        </div>
        <Link href={href} className="btn-ink rotate-1 px-[18px] py-1.5 text-[22px] no-underline">
          Resume →
        </Link>
      </div>
    </StickyNote>
  );
}
