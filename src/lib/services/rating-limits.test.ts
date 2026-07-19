import { describe, expect, it, vi, beforeEach } from 'vitest';

// rating-limits imports @/lib/db (throws at module eval without DATABASE_URL).
// Stub prisma so the burst contract can be exercised without a DB.
const count = vi.fn();
vi.mock('@/lib/db', () => ({ prisma: { resourceRating: { count: (...a: unknown[]) => count(...a) } } }));

import { ratingBurst } from '@/lib/services/rating-limits';
import { RATING_BURST_PER_HOUR, RATING_BURST_WINDOW_MS } from '@/lib/config';

describe('ratingBurst', () => {
  beforeEach(() => count.mockReset());

  it('allows while under the per-hour limit', async () => {
    count.mockResolvedValue(RATING_BURST_PER_HOUR - 1);
    expect(await ratingBurst('u1')).toEqual({
      allowed: true,
      used: RATING_BURST_PER_HOUR - 1,
      limit: RATING_BURST_PER_HOUR,
    });
  });

  it('blocks at the limit (used === limit is not allowed)', async () => {
    count.mockResolvedValue(RATING_BURST_PER_HOUR);
    expect((await ratingBurst('u1')).allowed).toBe(false);
  });

  it('blocks above the limit', async () => {
    count.mockResolvedValue(RATING_BURST_PER_HOUR + 50);
    expect((await ratingBurst('u1')).allowed).toBe(false);
  });

  it('counts only this user, within the rolling window', async () => {
    count.mockResolvedValue(0);
    const now = new Date('2026-07-19T12:00:00Z');
    await ratingBurst('u1', now);
    expect(count).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        updatedAt: { gte: new Date(now.getTime() - RATING_BURST_WINDOW_MS) },
      },
    });
  });
});
