// Notebook UI (Block B): one dashboard "table of contents" chapter row. In our
// system a chapter is a PROGRAM (the design mocked flat courses): tilted chip,
// title with a dotted leader to an optional edge label, meta + next-up lines,
// progress doodle, and a Resume chip. The design's page numbers were a
// skeuomorph with nothing to map to — the edge slot shows real info instead.

import Link from 'next/link';
import type { Accent } from './accents';
import { ChapterChip, ProgressDoodle } from './primitives';
import { pctComplete } from '@/lib/format';

export function TocEntry({
  chapter,
  accent,
  title,
  meta,
  nextUp,
  done,
  total,
  href,
  edge,
}: {
  chapter: string; // roman numeral / index label
  accent: Accent;
  title: string;
  meta: string; // e.g. "Goal-driven program · 4 courses"
  nextUp?: string; // next incomplete lesson, if any
  done: number;
  total: number;
  href: string;
  edge?: string; // right-edge label after the dotted leader, e.g. "3/4 built"
}) {
  const pct = pctComplete(done, total);
  const complete = total > 0 && done >= total;

  return (
    <Link
      href={href}
      className="nb-hl-hover flex items-start gap-4 border-b border-dashed border-rule py-3.5 no-underline"
    >
      <ChapterChip label={chapter} bg={accent.bg} className="mt-0.5" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-hand text-[28px] font-bold leading-none text-script">{title}</span>
          <span className="min-w-6 flex-1 -translate-y-1 border-b-2 border-dotted border-desk" />
          {edge && <span className="font-script text-sm text-script-dim">{edge}</span>}
        </div>
        <div className="mt-0.5 font-script text-xs text-script-dim">{meta}</div>

        {nextUp && (
          <div className="mt-2 flex items-center gap-2">
            <svg width="15" height="15" viewBox="0 0 24 24" className="-rotate-[4deg] flex-none" style={{ fill: accent.ink }} aria-hidden>
              <path d="M7 5l12 7-12 7z" />
            </svg>
            <span className="font-script text-sm italic text-script-body">Next: {nextUp}</span>
          </div>
        )}

        <div className="mt-2 flex max-w-[420px] items-center gap-3">
          <ProgressDoodle pct={pct} ink={accent.ink} className="flex-1" />
          <span className="w-[88px] font-script text-sm" style={{ color: accent.ink }}>
            {complete ? 'done ✓' : `${done}/${total} · ${pct}%`}
          </span>
        </div>
      </div>

      <span
        className="flex-none self-center rotate-1 rounded-[8px_10px_9px_11px] px-[15px] py-[5px] font-hand text-[20px] font-bold text-white shadow-[0_3px_0_rgba(0,0,0,.22)]"
        style={{ background: accent.ink }}
      >
        Resume →
      </span>
    </Link>
  );
}
