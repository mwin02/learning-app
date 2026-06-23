// Phase 2.6 (learn UI): the three at-a-glance stat cards. Recreated from the Home
// Summary (Hi-Fi) prototype, adapted to our data: the middle "Time spent" card
// (no time tracking yet) is replaced by "Lessons completed".

import { ProgressRing } from './primitives';

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
    <div className="mb-[var(--space-section)] grid grid-cols-[1.5fr_1fr_1fr] gap-[14px]">
      <div className="card flex items-center gap-4 p-5">
        <ProgressRing pct={progressPct} size={62} thickness={8}>
          <span className="text-md font-bold">{progressPct}%</span>
        </ProgressRing>
        <div>
          <div className="eyebrow">OVERALL PROGRESS</div>
          <div className="mt-[3px] text-md font-semibold">
            {doneCount} of {totalLessons} lessons
          </div>
          <div className="mt-px text-xs text-muted">
            {progressPct === 0
              ? 'Start when you’re ready'
              : progressPct === 100
                ? 'Course complete 🎉'
                : 'On track — keep going'}
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="eyebrow">LESSONS COMPLETED</div>
        <div className="stat-value mt-2">{doneCount}</div>
        <div className="mt-0.5 text-xs text-muted">of {totalLessons}</div>
      </div>

      <div className="card p-5">
        <div className="eyebrow">TIME REMAINING</div>
        <div className="stat-value mt-2">{timeRemainingLabel}</div>
        <div className="mt-0.5 text-xs text-muted">at your pace</div>
      </div>
    </div>
  );
}
