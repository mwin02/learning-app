// Phase 2.6 (learn UI): the course-content breakdown card — one row per section
// with a number badge, progress bar, fraction, and status pill. Recreated from the
// Home Summary (Hi-Fi) prototype. Presentational; sections come from the model.

import { ProgressBar, StatusPill, SECTION_STATUS_STYLE } from './primitives';
import type { CourseHomeSection } from '@/lib/course-home-model';

function SectionRow({ section }: { section: CourseHomeSection }) {
  const style = SECTION_STATUS_STYLE[section.status];
  return (
    <div className="flex items-center gap-4 border-t border-line-faint px-5 py-[15px]">
      <div
        className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-control font-mono text-sm font-semibold"
        style={{ background: style.bg, color: style.color }}
      >
        {section.n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-md font-semibold">{section.title}</div>
        <div className="meta-xs mt-0.5">
          {section.countLabel} · {section.durLabel}
        </div>
      </div>
      <ProgressBar
        pct={section.barPct}
        fill={style.color}
        track="var(--color-line-soft)"
        className="w-[110px] flex-none"
      />
      <span className="meta w-[34px] text-right">{section.fraction}</span>
      <StatusPill status={section.status} />
    </div>
  );
}

export function CourseContentBreakdown({
  sections,
  totalLessons,
}: {
  sections: CourseHomeSection[];
  totalLessons: number;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 pb-[14px] pt-[18px]">
        <div className="eyebrow">COURSE CONTENT</div>
        <div className="meta-xs">
          {sections.length} section{sections.length === 1 ? '' : 's'} · {totalLessons} lessons
        </div>
      </div>
      {sections.map((section) => (
        <SectionRow key={section.id} section={section} />
      ))}
    </div>
  );
}
