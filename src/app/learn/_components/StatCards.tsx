// Phase 2.6 (learn UI): the three at-a-glance stat cards. Recreated from the Home
// Summary (Hi-Fi) prototype, adapted to our data: the middle "Time spent" card
// (no time tracking yet) is replaced by "Lessons completed".

import { MONO, ProgressRing } from './primitives';

const CARD = 'rounded-[14px] border border-[#e7eaef] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]';
const LABEL = 'text-[10px] tracking-[1.5px] text-[#9aa2ad]';

export function StatCards({
  progressPct,
  doneCount,
  totalLessons,
  timeRemainingLabel,
}: {
  progressPct: number;
  doneCount: number;
  totalLessons: number;
  timeRemainingLabel: string;
}) {
  return (
    <div className="mb-[26px] grid grid-cols-[1.5fr_1fr_1fr] gap-[14px]">
      <div className={`flex items-center gap-4 ${CARD}`}>
        <ProgressRing pct={progressPct} size={62} thickness={8}>
          <span className="text-[15px] font-bold">{progressPct}%</span>
        </ProgressRing>
        <div>
          <div className={`${LABEL} ${MONO}`}>OVERALL PROGRESS</div>
          <div className="mt-[3px] text-[15px] font-semibold">
            {doneCount} of {totalLessons} lessons
          </div>
          <div className="mt-px text-xs text-[#8a93a0]">
            {progressPct === 0
              ? 'Start when you’re ready'
              : progressPct === 100
                ? 'Course complete 🎉'
                : 'On track — keep going'}
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={`${LABEL} ${MONO}`}>LESSONS COMPLETED</div>
        <div className="mt-2 text-[26px] font-bold tracking-[-0.5px]">{doneCount}</div>
        <div className="mt-0.5 text-xs text-[#8a93a0]">of {totalLessons}</div>
      </div>

      <div className={CARD}>
        <div className={`${LABEL} ${MONO}`}>TIME REMAINING</div>
        <div className="mt-2 text-[26px] font-bold tracking-[-0.5px]">{timeRemainingLabel}</div>
        <div className="mt-0.5 text-xs text-[#8a93a0]">at your pace</div>
      </div>
    </div>
  );
}
