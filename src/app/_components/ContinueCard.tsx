// UI Block 8: the home page's "pick up where you left off" bookmark — the last
// program the viewer worked on (latest Progress row; newest enrollment when
// they haven't completed anything yet), deep-linking to the first incomplete
// lesson in plan order. Server component; the page assembles the data.

import Link from 'next/link';
import { accentFor } from '@/components/notebook/accents';
import { ProgressDoodle } from '@/components/notebook/primitives';

export type ContinueCardData = {
  programId: string;
  title: string;
  nextUp: string | null; // next incomplete lesson title; null = program complete
  href: string; // lesson deep link, or program home when complete
  done: number;
  total: number;
  started: boolean; // false → "Start"; true → "Continue"
};

export function ContinueCard({ card }: { card: ContinueCardData }) {
  const accent = accentFor(0);
  const pct = card.total > 0 ? Math.round((card.done / card.total) * 100) : 0;
  const complete = card.total > 0 && card.done >= card.total;

  return (
    <Link
      href={card.href}
      className="mb-9 block max-w-[660px] -rotate-[0.4deg] rounded border-2 border-note-edge bg-note px-6 py-5 no-underline shadow-[0_3px_10px_rgba(0,0,0,.08)] hover:brightness-[0.99]"
    >
      <div className="nb-kicker mb-1 text-note-label">
        {card.started ? '⌘ pick up where you left off —' : '⌘ your newest program —'}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="font-hand text-[32px] font-bold leading-[1.05] text-script">
            {card.title}
          </div>
          {card.nextUp && (
            <div className="mt-1.5 flex items-center gap-2">
              <svg width="15" height="15" viewBox="0 0 24 24" className="-rotate-[4deg] flex-none" style={{ fill: accent.ink }} aria-hidden>
                <path d="M7 5l12 7-12 7z" />
              </svg>
              <span className="font-script text-sm italic text-script-body">
                Next: {card.nextUp}
              </span>
            </div>
          )}
          <div className="mt-2.5 flex max-w-[420px] items-center gap-3">
            <ProgressDoodle pct={pct} ink={accent.ink} className="flex-1" />
            <span className="font-script text-sm" style={{ color: accent.ink }}>
              {complete ? 'done ✓' : `${card.done}/${card.total} · ${pct}%`}
            </span>
          </div>
        </div>
        <span
          className="flex-none rotate-1 rounded-[8px_10px_9px_11px] px-[18px] py-[7px] font-hand text-[22px] font-bold text-white shadow-[0_3px_0_rgba(0,0,0,.22)]"
          style={{ background: accent.ink }}
        >
          {complete ? 'Revisit →' : card.started ? 'Continue →' : 'Start →'}
        </span>
      </div>
    </Link>
  );
}
