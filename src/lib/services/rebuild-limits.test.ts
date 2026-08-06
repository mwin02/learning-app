import { describe, expect, it, vi, beforeEach } from 'vitest';

// rebuild-limits imports @/lib/db (throws at module eval without DATABASE_URL).
const count = vi.fn();
const findFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    courseRequest: {
      count: (...a: unknown[]) => count(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
  },
}));

import { findRecentRebuild, rebuildQuota } from '@/lib/services/rebuild-limits';
import {
  COURSE_REQUEST_STALE_MS,
  FREE_TRACK_REBUILDS_PER_MONTH,
  TRACK_REBUILD_DEDUP_WINDOW_MS,
} from '@/lib/config';

describe('rebuildQuota', () => {
  beforeEach(() => count.mockReset());

  it('allows while under the monthly limit', async () => {
    count.mockResolvedValue(FREE_TRACK_REBUILDS_PER_MONTH - 1);
    expect(await rebuildQuota('u1')).toEqual({
      allowed: true,
      used: FREE_TRACK_REBUILDS_PER_MONTH - 1,
      limit: FREE_TRACK_REBUILDS_PER_MONTH,
    });
  });

  it('blocks at the limit (used === limit is not allowed)', async () => {
    count.mockResolvedValue(FREE_TRACK_REBUILDS_PER_MONTH);
    expect((await rebuildQuota('u1')).allowed).toBe(false);
  });

  it('counts only this user\'s rebuilds this UTC month, excluding failed ones', async () => {
    count.mockResolvedValue(0);
    await rebuildQuota('u1', new Date('2026-08-20T09:30:00Z'));
    expect(count).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        replacesTrackId: { not: null },
        createdAt: { gte: new Date('2026-08-01T00:00:00Z') },
        status: { not: 'failed' },
      },
    });
  });
});

describe('findRecentRebuild', () => {
  beforeEach(() => findFirst.mockReset());

  it("matches only the caller's own IN-FLIGHT rebuild of the same slot, inside the window", async () => {
    findFirst.mockResolvedValue({ id: 'req1', status: 'queued' });
    const now = new Date('2026-08-05T12:00:00Z');
    expect(await findRecentRebuild('u1', 'p1', 'calculus', now)).toEqual({
      id: 'req1',
      status: 'queued',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        programId: 'p1',
        topic: 'calculus',
        replacesTrackId: { not: null },
        status: { in: ['queued', 'running'] },
        createdAt: { gte: new Date(now.getTime() - TRACK_REBUILD_DEDUP_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
  });

  // There is no payload fingerprint here, so status is the ONLY thing separating a
  // double-submit from a second legitimate rebuild. A `fulfilled` predecessor
  // matching would hand the learner a finished request's id for a build that never
  // happens — the exact loop the feature exists to serve.
  it('excludes terminal rebuilds so a finished one cannot dedup a fresh request', async () => {
    findFirst.mockResolvedValue(null);
    await findRecentRebuild('u1', 'p1', 'calculus');
    const status: { in: string[] } = findFirst.mock.calls[0][0].where.status;
    expect(status.in).not.toContain('fulfilled');
    expect(status.in).not.toContain('failed');
  });

  it('returns null when there is no in-flight rebuild', async () => {
    findFirst.mockResolvedValue(null);
    expect(await findRecentRebuild('u1', 'p1', 'calculus')).toBeNull();
  });

  // The window is an age bound on an in-flight row, so it must not expire a rebuild
  // the queue still considers live — otherwise a learner is refused their own
  // running build. Pinned so the two knobs can't drift apart.
  it('spans at least as long as a request can legitimately stay in flight', () => {
    expect(TRACK_REBUILD_DEDUP_WINDOW_MS).toBeGreaterThanOrEqual(COURSE_REQUEST_STALE_MS);
  });
});
