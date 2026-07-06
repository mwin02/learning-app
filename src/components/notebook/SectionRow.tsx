// Notebook UI (Block B): one row of the course-content breakdown (sections
// live INSIDE the sheet in the redesign; the bookmark tabs are courses).
// Numbered chip, title + meta, progress doodle, fraction, status word.

import type { Accent } from './accents';
import { ChapterChip, ProgressDoodle } from './primitives';
import { pctComplete } from '@/lib/format';

export function SectionRow({
  n,
  accent,
  title,
  meta,
  done,
  total,
}: {
  n: number;
  accent: Accent;
  title: string;
  meta: string; // e.g. "4 lessons · ~2h"
  done: number;
  total: number;
}) {
  const pct = pctComplete(done, total);
  const status = done >= total && total > 0 ? 'completed ✓' : done === 0 ? 'not started' : 'in progress';

  return (
    <div className="flex items-center gap-4 border-b border-dashed border-rule py-[9px]">
      <ChapterChip label={String(n)} bg={accent.bg} size={36} />
      <div className="min-w-0 flex-1">
        <div className="font-hand text-[24px] font-bold leading-none text-script">{title}</div>
        <div className="font-script text-2xs text-script-dim">{meta}</div>
      </div>
      <ProgressDoodle pct={pct} ink={accent.ink} className="w-[120px] flex-none" />
      <span className="w-[38px] text-right font-script text-sm text-script-faint">
        {done}/{total}
      </span>
      <span className="w-24 text-center font-script text-xs" style={{ color: accent.ink }}>
        {status}
      </span>
    </div>
  );
}
