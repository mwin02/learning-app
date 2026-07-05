'use client';

// UI Block 9: the home page's GitHub-style study log — one cell per local-
// timezone day over the last 26 full weeks (+ the current partial one), shaded
// by lessons completed that day. Client component because bucketing must use
// the VIEWER's timezone (server-side UTC days would shift late-night sessions
// to the wrong cell); the grid renders after mount so server HTML (which can't
// know the client's "today") never mismatches — a fixed-height shim holds the
// layout meanwhile. Colors mix notebook tokens so dark mode resolves for free.

import { useEffect, useState } from 'react';

const WEEKS = 26; // full weeks before the current partial column
const CELL = 18;
const GAP = 4;
const ROW = CELL + GAP;
const GUTTER = 34; // weekday-label gutter left of the grid
const MONTH_ROW = 18; // month-label row above the grid

type Day = { count: number; title: string };
type Week = { days: Day[]; monthLabel: string | null };

// 0 = empty ruled cell; 1–4 mix the green accent ink over the paper.
const LEVEL_BG = [
  'color-mix(in srgb, var(--color-rule) 40%, transparent)',
  'color-mix(in srgb, var(--color-nb-green-ink) 30%, transparent)',
  'color-mix(in srgb, var(--color-nb-green-ink) 55%, transparent)',
  'color-mix(in srgb, var(--color-nb-green-ink) 78%, transparent)',
  'var(--color-nb-green-ink)',
];

export function levelOf(count: number, max: number): number {
  return count === 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4));
}

export function buildWeeks(completions: number[]): { weeks: Week[]; total: number; max: number } {
  // Bucket completion instants into local calendar days.
  const counts = new Map<string, number>();
  for (const ts of completions) {
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Grid origin: the Sunday starting the column WEEKS before this week's.
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - cursor.getDay() - WEEKS * 7);

  const weeks: Week[] = [];
  let total = 0;
  let max = 0;
  let prevMonth = -1;
  while (cursor <= today) {
    const monthAtStart = cursor.getMonth();
    const week: Week = {
      days: [],
      monthLabel:
        monthAtStart !== prevMonth
          ? cursor.toLocaleDateString(undefined, { month: 'short' })
          : null,
    };
    prevMonth = monthAtStart;
    for (let dow = 0; dow < 7 && cursor <= today; dow++) {
      const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
      const count = counts.get(key) ?? 0;
      total += count;
      max = Math.max(max, count);
      const dateLabel = cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      week.days.push({
        count,
        title: `${count === 0 ? 'no' : count} lesson${count === 1 ? '' : 's'} · ${dateLabel}`,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return { weeks, total, max };
}

type Hover = { left: number; top: number; title: string };

export function ActivityHeatmap({ completions }: { completions: number[] }) {
  const [grid, setGrid] = useState<ReturnType<typeof buildWeeks> | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => setGrid(buildWeeks(completions)), [completions]);

  // Server/pre-mount shim: month row + 7 cell rows + legend row.
  if (!grid) return <div style={{ height: MONTH_ROW + 7 * ROW + 28 }} aria-hidden />;

  const { weeks, total, max } = grid;

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded border border-note-edge bg-note px-2.5 py-1 font-script text-xs text-script-body shadow-[0_2px_6px_rgba(0,0,0,.15)]"
          style={{ left: hover.left, top: hover.top - 6 }}
        >
          {hover.title}
        </div>
      )}

      {/* month labels */}
      <div className="flex" style={{ gap: GAP, paddingLeft: GUTTER, height: MONTH_ROW }}>
        {weeks.map((week, i) => (
          <div key={i} className="relative" style={{ width: CELL }}>
            {week.monthLabel && (
              <span className="absolute left-0 top-0 whitespace-nowrap font-script text-xs text-script-dim">
                {week.monthLabel}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="flex" style={{ gap: GAP }}>
        {/* weekday labels */}
        <div className="relative" style={{ width: GUTTER - GAP, height: 7 * ROW - GAP }}>
          {[
            ['mon', 1],
            ['wed', 3],
            ['fri', 5],
          ].map(([label, row]) => (
            <span
              key={label}
              className="absolute left-0 font-script text-xs leading-none text-script-dim"
              style={{ top: (row as number) * ROW + 4 }}
            >
              {label}
            </span>
          ))}
        </div>

        {weeks.map((week, i) => (
          <div key={i} className="flex flex-col" style={{ gap: GAP }}>
            {week.days.map((day, j) => (
              <div
                key={j}
                onMouseEnter={() =>
                  setHover({
                    left: GUTTER + i * (CELL + GAP) + CELL / 2,
                    top: MONTH_ROW + j * ROW,
                    title: day.title,
                  })
                }
                className="rounded-[3px]"
                style={{ width: CELL, height: CELL, background: LEVEL_BG[levelOf(day.count, max)] }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* legend + total */}
      <div className="mt-2.5 flex items-center gap-3" style={{ paddingLeft: GUTTER }}>
        <span className="font-script text-xs text-script-faint">
          {total} lesson{total === 1 ? '' : 's'} in the last 6 months
        </span>
        <span className="flex-1" />
        <span className="font-script text-2xs text-script-dim">less</span>
        <span className="flex" style={{ gap: GAP }}>
          {LEVEL_BG.map((bg, level) => (
            <span key={level} className="rounded-[3px]" style={{ width: 12, height: 12, background: bg }} />
          ))}
        </span>
        <span className="font-script text-2xs text-script-dim">more</span>
      </div>
    </div>
  );
}
