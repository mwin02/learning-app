// Phase 2.6 (learn UI): the course-content breakdown card — one row per section
// with a number badge, progress bar, fraction, and status pill. Recreated from the
// Home Summary (Hi-Fi) prototype. Presentational; sections come from the model.

import { MONO, ProgressBar, StatusPill, SECTION_STATUS_STYLE } from './primitives';
import type { CourseHomeSection } from '@/lib/course-home-model';

function SectionRow({ section }: { section: CourseHomeSection }) {
  const style = SECTION_STATUS_STYLE[section.status];
  return (
    <div className="flex items-center gap-4 border-t border-[#f0f2f5] px-5 py-[15px]">
      <div
        className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[9px] text-[13px] font-semibold ${MONO}`}
        style={{ background: style.bg, color: style.color }}
      >
        {section.n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{section.title}</div>
        <div className={`mt-0.5 text-[10px] text-[#9aa2ad] ${MONO}`}>
          {section.countLabel} · {section.durLabel}
        </div>
      </div>
      <ProgressBar pct={section.barPct} fill={style.color} track="#eef1f5" className="w-[110px] flex-none" />
      <span className={`w-[34px] text-right text-[11px] text-[#8a93a0] ${MONO}`}>
        {section.fraction}
      </span>
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
    <div className="overflow-hidden rounded-[14px] border border-[#e7eaef] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="flex items-center justify-between px-5 pb-[14px] pt-[18px]">
        <div className={`text-[10px] tracking-[1.5px] text-[#9aa2ad] ${MONO}`}>COURSE CONTENT</div>
        <div className={`text-[10px] text-[#aab2bd] ${MONO}`}>
          {sections.length} section{sections.length === 1 ? '' : 's'} · {totalLessons} lessons
        </div>
      </div>
      {sections.map((section) => (
        <SectionRow key={section.id} section={section} />
      ))}
    </div>
  );
}
