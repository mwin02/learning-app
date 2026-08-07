import { describe, expect, it, vi, beforeEach } from 'vitest';

// report-limits imports @/lib/db (throws at module eval without DATABASE_URL).
// Stub prisma so the burst contract can be exercised without a DB.
type CountArgs = { where: { userId: string; createdAt: { gte: Date } } };
const count = vi.fn<(args: CountArgs) => Promise<number>>();
vi.mock('@/lib/db', () => ({ prisma: { resourceReport: { count: (a: CountArgs) => count(a) } } }));

import { reportBurst, reportRepeat } from '@/lib/services/report-limits';
import {
  REPORT_BURST_PER_HOUR,
  REPORT_BURST_WINDOW_MS,
  REPORT_REPEAT_COOLDOWN_MS,
  RATING_BURST_PER_HOUR,
} from '@/lib/config';

function lastWhere(): CountArgs['where'] {
  const call = count.mock.calls.at(-1);
  if (!call) throw new Error('prisma.resourceReport.count was never called');
  return call[0].where;
}

describe('reportBurst', () => {
  beforeEach(() => count.mockReset());

  it('allows while under the per-hour limit', async () => {
    count.mockResolvedValue(REPORT_BURST_PER_HOUR - 1);
    expect(await reportBurst('u1')).toEqual({
      allowed: true,
      used: REPORT_BURST_PER_HOUR - 1,
      limit: REPORT_BURST_PER_HOUR,
    });
  });

  it('blocks at the limit (used === limit is not allowed)', async () => {
    count.mockResolvedValue(REPORT_BURST_PER_HOUR);
    expect((await reportBurst('u1')).allowed).toBe(false);
  });

  it('blocks above the limit', async () => {
    count.mockResolvedValue(REPORT_BURST_PER_HOUR + 50);
    expect((await reportBurst('u1')).allowed).toBe(false);
  });

  it('counts only this user, within the rolling window', async () => {
    count.mockResolvedValue(0);
    const now = new Date('2026-08-05T12:00:00Z');
    await reportBurst('u1', now);
    expect(count).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        createdAt: { gte: new Date(now.getTime() - REPORT_BURST_WINDOW_MS) },
      },
    });
  });

  // Why the window is createdAt: operator triage and the dead-link probe write
  // these rows too, and every such write bumps @updatedAt — an updatedAt window
  // would spend the learner's budget on writes they didn't make.
  it('ignores rows created before the window but updated inside it', async () => {
    count.mockResolvedValue(0);
    const now = new Date('2026-08-05T12:00:00Z');
    const touchedByAnother = {
      createdAt: new Date(now.getTime() - REPORT_BURST_WINDOW_MS - 60_000),
      updatedAt: now,
    };
    const burst = await reportBurst('u1', now);
    expect(touchedByAnother.createdAt.getTime()).toBeLessThan(lastWhere().createdAt.gte.getTime());
    expect(burst).toEqual({ allowed: true, used: 0, limit: REPORT_BURST_PER_HOUR });
  });

  // Locked in the plan: reporting is rare and deliberate, and its payload is free
  // text, so its cap must stay well under the vote cap even if either knob moves.
  it('is capped well below the rating burst', () => {
    expect(REPORT_BURST_PER_HOUR).toBeLessThan(RATING_BURST_PER_HOUR);
  });
});

// The other half of the createdAt switch: reportBurst deliberately cannot see a
// re-report (it creates no row), so this is the only thing standing between one
// existing row and an unbounded loop through the handler and its outbound probe.
describe('reportRepeat', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const ago = (ms: number) => ({ updatedAt: new Date(now.getTime() - ms) });

  it('allows a first report, which has no row to cool down', () => {
    expect(reportRepeat(null, now)).toEqual({ allowed: true });
  });

  it('refuses a re-report inside the cooldown and says how long is left', () => {
    expect(reportRepeat(ago(60_000), now)).toEqual({
      allowed: false,
      retryAfterMs: REPORT_REPEAT_COOLDOWN_MS - 60_000,
    });
  });

  it('allows a re-report once the cooldown has elapsed', () => {
    expect(reportRepeat(ago(REPORT_REPEAT_COOLDOWN_MS), now)).toEqual({ allowed: true });
    expect(reportRepeat(ago(REPORT_REPEAT_COOLDOWN_MS + 1), now)).toEqual({ allowed: true });
  });

  it('never advertises a wait longer than the cooldown, even on a future timestamp', () => {
    const skewed = reportRepeat({ updatedAt: new Date(now.getTime() + 60_000) }, now);
    expect(skewed).toEqual({ allowed: false, retryAfterMs: REPORT_REPEAT_COOLDOWN_MS });
  });

  // A loop is worth at most this many trips through the handler per hour per
  // (resource, category) — the property the cap exists for. Pinned so a later
  // loosening of the knob has to be deliberate.
  it('holds one row to a handful of submissions an hour', () => {
    expect(REPORT_BURST_WINDOW_MS / REPORT_REPEAT_COOLDOWN_MS).toBeLessThanOrEqual(6);
  });
});
