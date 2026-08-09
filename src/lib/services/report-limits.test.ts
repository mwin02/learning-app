import { describe, expect, it, vi, beforeEach } from 'vitest';

// report-limits imports @/lib/db (throws at module eval without DATABASE_URL).
// Stub prisma so the burst contract can be exercised without a DB.
const count = vi.fn();
vi.mock('@/lib/db', () => ({ prisma: { resourceReport: { count: (...a: unknown[]) => count(...a) } } }));

import { reportBurst } from '@/lib/services/report-limits';
import { REPORT_BURST_PER_HOUR, REPORT_BURST_WINDOW_MS, RATING_BURST_PER_HOUR } from '@/lib/config';

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
        updatedAt: { gte: new Date(now.getTime() - REPORT_BURST_WINDOW_MS) },
      },
    });
  });

  // Locked in the plan: reporting is rare and deliberate, and its payload is free
  // text, so its cap must stay well under the vote cap even if either knob moves.
  it('is capped well below the rating burst', () => {
    expect(REPORT_BURST_PER_HOUR).toBeLessThan(RATING_BURST_PER_HOUR);
  });
});
