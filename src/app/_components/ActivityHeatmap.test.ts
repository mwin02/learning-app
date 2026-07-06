// UI Block 9: the study-log grid math. buildWeeks runs against the real clock
// (the grid is anchored on "today"), so assertions are shape- and
// relative-date-based rather than pinned to fixed calendar dates.

import { describe, it, expect } from 'vitest';
import { buildWeeks, levelOf } from './ActivityHeatmap';

const DAY = 24 * 60 * 60 * 1000;

describe('levelOf', () => {
  it('maps zero to the empty level', () => {
    expect(levelOf(0, 5)).toBe(0);
  });
  it('maps the max to the darkest level', () => {
    expect(levelOf(5, 5)).toBe(4);
  });
  it('never rounds a nonzero count down to empty', () => {
    expect(levelOf(1, 100)).toBe(1);
  });
  it('scales intermediate counts across levels 1–4', () => {
    expect(levelOf(2, 8)).toBe(1);
    expect(levelOf(4, 8)).toBe(2);
    expect(levelOf(6, 8)).toBe(3);
  });
});

describe('buildWeeks', () => {
  it('builds 26 full weeks plus the current partial one, ending today', () => {
    const { weeks } = buildWeeks([]);
    expect(weeks).toHaveLength(27);
    for (const week of weeks.slice(0, 26)) expect(week.days).toHaveLength(7);
    const now = new Date();
    // The last column runs Sunday..today.
    expect(weeks[26].days).toHaveLength(now.getDay() + 1);
  });

  it('buckets completions into the same local day and totals them', () => {
    const now = Date.now();
    const { weeks, total, max } = buildWeeks([now, now - 1000, now - 2000]);
    expect(total).toBe(3);
    expect(max).toBe(3);
    const lastWeek = weeks[weeks.length - 1];
    const todayCell = lastWeek.days[lastWeek.days.length - 1];
    expect(todayCell.count).toBe(3);
    expect(todayCell.title).toMatch(/^3 lessons · /);
  });

  it('ignores completions outside the grid window', () => {
    const { total } = buildWeeks([Date.now() - 200 * DAY]);
    expect(total).toBe(0);
  });

  it('labels a column only when its month differs from the previous column', () => {
    const { weeks } = buildWeeks([]);
    expect(weeks[0].monthLabel).not.toBeNull();
    const labels = weeks.filter((w) => w.monthLabel != null);
    // 27 weeks span 6–8 calendar months.
    expect(labels.length).toBeGreaterThanOrEqual(6);
    expect(labels.length).toBeLessThanOrEqual(8);
  });

  it('pluralizes the empty-day tooltip', () => {
    const { weeks } = buildWeeks([]);
    expect(weeks[0].days[0].title).toMatch(/^no lessons · /);
  });
});
