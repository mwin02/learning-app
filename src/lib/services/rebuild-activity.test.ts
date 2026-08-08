import { describe, expect, it, vi, beforeEach } from 'vitest';

// rebuild-activity imports @/lib/db (throws at module eval without DATABASE_URL).
const findFirst = vi.fn();
const count = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    courseRequest: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      count: (...a: unknown[]) => count(...a),
    },
  },
}));

import { latestRebuildFor, rebuildNotice, type LatestRebuild } from '@/lib/services/rebuild-activity';
import { REBUILD_FAILURE_NOTICE_MS, TRACK_REBUILD_DEDUP_WINDOW_MS } from '@/lib/config';

const NOW = new Date('2026-08-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const rebuild = (over: Partial<LatestRebuild>): LatestRebuild => ({
  status: 'queued',
  createdAt: ago(60_000),
  updatedAt: ago(60_000),
  siblingsInFlight: false,
  ...over,
});

describe('rebuildNotice', () => {
  it('says nothing when this track has never been rebuilt', () => {
    expect(rebuildNotice(null, NOW)).toBeNull();
  });

  it('reports an in-flight rebuild for queued and running requests', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(rebuildNotice(rebuild({ status }), NOW)?.kind).toBe('building');
    }
  });

  // Otherwise a tab left open while the workers are down polls every 5s forever,
  // against copy the rebuild dialog already contradicts.
  it('stops reporting a request the rebuild dialog has already given up on', () => {
    const stale = { createdAt: ago(TRACK_REBUILD_DEDUP_WINDOW_MS + 1) };
    expect(rebuildNotice(rebuild({ status: 'queued', ...stale }), NOW)).toBeNull();
    expect(rebuildNotice(rebuild({ status: 'running', ...stale }), NOW)).toBeNull();
  });

  it('keeps reporting in-flight after fulfilment while the repoint is still pending', () => {
    expect(rebuildNotice(rebuild({ status: 'fulfilled', createdAt: ago(1000) }), NOW)?.kind).toBe('building');
  });

  // The assembler refuses to repoint while any sibling of the program is building, so
  // an unrelated in-flight build can block this slot for far longer than any window.
  it('keeps reporting in-flight for an old fulfilled rebuild whose siblings are still building', () => {
    const notice = rebuildNotice(
      rebuild({
        status: 'fulfilled',
        createdAt: ago(TRACK_REBUILD_DEDUP_WINDOW_MS * 3),
        siblingsInFlight: true,
      }),
      NOW,
    );
    expect(notice?.kind).toBe('building');
  });

  it('falls silent for an old fulfilled rebuild once nothing is left to wait for', () => {
    const notice = rebuildNotice(
      rebuild({
        status: 'fulfilled',
        createdAt: ago(TRACK_REBUILD_DEDUP_WINDOW_MS * 3),
        siblingsInFlight: false,
      }),
      NOW,
    );
    expect(notice).toBeNull();
  });

  it('reports a recent failure', () => {
    const notice = rebuildNotice(rebuild({ status: 'failed', updatedAt: ago(3600_000) }), NOW);
    expect(notice?.kind).toBe('failed');
    expect(notice?.title).toMatch(/didn/);
  });

  it('stops reporting a failure once it is older than the notice window', () => {
    const old = ago(REBUILD_FAILURE_NOTICE_MS + 1);
    expect(rebuildNotice(rebuild({ status: 'failed', createdAt: old, updatedAt: old }), NOW)).toBeNull();
  });
});

describe('latestRebuildFor', () => {
  beforeEach(() => {
    findFirst.mockReset();
    count.mockReset();
  });

  it('asks for the newest request replacing this track, within this program', async () => {
    findFirst.mockResolvedValue(null);
    expect(await latestRebuildFor('p1', 't1')).toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId: 'p1', replacesTrackId: 't1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(count).not.toHaveBeenCalled();
  });

  it('reads the program\'s in-flight siblings only for a fulfilled rebuild', async () => {
    findFirst.mockResolvedValue({ status: 'fulfilled', createdAt: NOW, updatedAt: NOW });
    count.mockResolvedValue(1);
    expect(await latestRebuildFor('p1', 't1')).toMatchObject({ siblingsInFlight: true });
    expect(count).toHaveBeenCalledWith({
      where: { programId: 'p1', status: { in: ['queued', 'running'] } },
    });
  });

  it('does not query siblings for a still-running rebuild', async () => {
    findFirst.mockResolvedValue({ status: 'running', createdAt: NOW, updatedAt: NOW });
    expect(await latestRebuildFor('p1', 't1')).toMatchObject({ siblingsInFlight: false });
    expect(count).not.toHaveBeenCalled();
  });
});
