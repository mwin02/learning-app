// Unit tests for the pending-review `decompose` action (atomic → 'pending'
// re-route + reject-style candidate-link cleanup) and its schema variant.
// Prisma is stubbed (module-eval gotcha: @/lib/db validates env at import), so
// these run secret-free; the approve/reject paths are covered by the live
// drivers and the playground, so only the new action is unit-tested here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  const prisma = {
    resource: { findUnique: vi.fn(), updateMany: vi.fn() },
    conceptResource: { findMany: vi.fn(), deleteMany: vi.fn() },
    // Interactive transaction: run the callback against the same stub so the
    // tx client's calls are observable on `prisma.*`.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  return { prisma };
});
vi.mock('@/lib/agents/map/recompute-readiness', () => ({ recomputeReadiness: vi.fn() }));
vi.mock('@/lib/agents/content/mark-bank-stale', () => ({ markBankStale: vi.fn() }));

import { prisma } from '@/lib/db';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { markBankStale } from '@/lib/agents/content/mark-bank-stale';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { pendingReviewSchema } from '@/lib/api/pending-review-schema';

const findUnique = vi.mocked(prisma.resource.findUnique);
const updateMany = vi.mocked(prisma.resource.updateMany);
const linkFindMany = vi.mocked(prisma.conceptResource.findMany);
const linkDeleteMany = vi.mocked(prisma.conceptResource.deleteMany);
const recompute = vi.mocked(recomputeReadiness);

beforeEach(() => {
  vi.clearAllMocks();
  linkFindMany.mockResolvedValue([] as never);
  linkDeleteMany.mockResolvedValue({ count: 0 } as never);
});

describe('applyPendingReview decompose action', () => {
  it('returns not_found for an unknown id', async () => {
    findUnique.mockResolvedValue(null as never);
    const result = await applyPendingReview({ action: 'decompose', resourceId: 'nope' });
    expect(result.kind).toBe('not_found');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('flips an atomic row to pending with a race-guarded conditional update', async () => {
    findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus: 'atomic' } as never);
    updateMany.mockResolvedValue({ count: 1 } as never);
    const result = await applyPendingReview({ action: 'decompose', resourceId: 'res_1' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'res_1', decompositionStatus: 'atomic' },
      data: { decompositionStatus: 'pending' },
    });
    expect(result).toEqual({
      kind: 'queued_decompose',
      resourceId: 'res_1',
      conceptLinksRemoved: 0,
      pathsRecomputed: 0,
      pathsRegressed: 0,
    });
  });

  it('drops candidate links, marks banks stale, and recomputes affected paths (reject-style cleanup)', async () => {
    findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus: 'atomic' } as never);
    updateMany.mockResolvedValue({ count: 1 } as never);
    linkFindMany.mockResolvedValue([
      { conceptId: 'c1', role: 'teaches', concept: { pathId: 'p1' } },
      { conceptId: 'c2', role: 'uses', concept: { pathId: 'p1' } },
      { conceptId: 'c3', role: 'teaches', concept: { pathId: 'p2' } },
    ] as never);
    linkDeleteMany.mockResolvedValue({ count: 3 } as never);
    recompute
      .mockResolvedValueOnce({ status: 'building' } as never)
      .mockResolvedValueOnce({ status: 'spine_ready' } as never);

    const result = await applyPendingReview({ action: 'decompose', resourceId: 'res_1' });

    expect(linkDeleteMany).toHaveBeenCalledWith({ where: { resourceId: { in: ['res_1'] } } });
    expect(markBankStale).toHaveBeenCalledWith(expect.anything(), ['c2'], 'resource_removed');
    expect(markBankStale).toHaveBeenCalledWith(expect.anything(), ['c1', 'c3'], 'primary_changed');
    expect(recompute).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      kind: 'queued_decompose',
      resourceId: 'res_1',
      conceptLinksRemoved: 3,
      pathsRecomputed: 2,
      pathsRegressed: 1,
    });
  });

  it.each(['decomposed', 'pending', 'human_review', 'unsupported'] as const)(
    'rejects a %s row as not_atomic without writing',
    async (status) => {
      findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus: status } as never);
      const result = await applyPendingReview({ action: 'decompose', resourceId: 'res_1' });
      expect(result).toEqual({ kind: 'not_atomic', decompositionStatus: status });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('surfaces a lost race (row left atomic between read and write) without link cleanup', async () => {
    findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus: 'atomic' } as never);
    updateMany.mockResolvedValue({ count: 0 } as never);
    const result = await applyPendingReview({ action: 'decompose', resourceId: 'res_1' });
    expect(result.kind).toBe('raced');
    expect(linkDeleteMany).not.toHaveBeenCalled();
  });
});

describe('pendingReviewSchema decompose variant', () => {
  it('parses a decompose action', () => {
    expect(pendingReviewSchema.parse({ action: 'decompose', resourceId: 'res_1' })).toEqual({
      action: 'decompose',
      resourceId: 'res_1',
    });
  });

  it('still requires a resourceId', () => {
    expect(() => pendingReviewSchema.parse({ action: 'decompose' })).toThrow();
  });
});
