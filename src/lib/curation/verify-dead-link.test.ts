// Unit tests for R2's dead-link probe. The liveness checker is INJECTED, so the
// three verdict branches are exercised with no network; Prisma and
// applyPendingReview are stubbed (module-eval gotcha — @/lib/db validates env at
// import). The reject machinery itself is 2.5g-5's and has its own coverage;
// what R2 owns is WHICH verdict acts and what the report row ends up saying.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    resource: { findUnique: vi.fn() },
    resourceReport: { update: vi.fn() },
  },
}));
vi.mock('@/lib/curation/pending-review', () => ({ applyPendingReview: vi.fn() }));

import { prisma } from '@/lib/db';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { verifyDeadLink, type LivenessCheck } from '@/lib/curation/verify-dead-link';

const findUnique = vi.mocked(prisma.resource.findUnique);
const updateReport = vi.mocked(prisma.resourceReport.update);
const applyReview = vi.mocked(applyPendingReview);

const resourceRow = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  origin: 'agent',
  url: 'https://example.com/gone',
  deprecationSeverity: null,
  ...over,
});

const rejected = {
  kind: 'rejected' as const,
  resourceId: 'res_1',
  deprecated: 1,
  conceptLinksRemoved: 2,
  pathsRecomputed: 1,
  pathsRegressed: 0,
};

const dead: LivenessCheck = async () => ({ alive: false, reason: 'http 404' });
const suspect: LivenessCheck = async () => ({
  alive: false,
  reason: 'soft 404: page titled "Page not found"',
  quarantine: true,
});
const alive: LivenessCheck = async () => ({ alive: true });

const run = (check: LivenessCheck) =>
  verifyDeadLink({ resourceId: 'res_1', reportId: 'rep_1', check });

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(resourceRow() as never);
  applyReview.mockResolvedValue(rejected);
  updateReport.mockResolvedValue({} as never);
});

describe('verifyDeadLink', () => {
  it('authoritative death hard-rejects without cascade and auto-resolves the report', async () => {
    const result = await run(dead);
    expect(applyReview).toHaveBeenCalledWith({
      action: 'reject',
      resourceId: 'res_1',
      severity: 'hard',
      cascade: false,
    });
    expect(updateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rep_1' },
        data: expect.objectContaining({ state: 'auto_resolved', resolution: 'http 404' }),
      }),
    );
    expect(result).toMatchObject({
      outcome: 'confirmed_dead',
      state: 'auto_resolved',
      detail: 'http 404',
    });
  });

  it('heuristic death stamps the verdict but leaves the report open and the row active', async () => {
    const result = await run(suspect);
    expect(applyReview).not.toHaveBeenCalled();
    expect(updateReport).toHaveBeenCalledWith({
      where: { id: 'rep_1' },
      data: { resolution: 'soft 404: page titled "Page not found"' },
    });
    expect(result).toMatchObject({ outcome: 'inconclusive', state: 'open' });
  });

  it('a live URL is not a false report — nothing is written, the report stays open', async () => {
    // The khanacademy.org soft-404 class: the learner saw a dead page the probe
    // structurally cannot see, so the report survives for the operator.
    const result = await run(alive);
    expect(applyReview).not.toHaveBeenCalled();
    expect(updateReport).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'appears_live', state: 'open' });
  });

  it('an already-deprecated row auto-resolves without any network call', async () => {
    // A re-report of a link we already killed: R1's upsert reopened the row and
    // cleared its resolution, and this is what puts it back — otherwise every
    // re-reporter mints a contextless open row in R4's queue for a settled defect.
    findUnique.mockResolvedValue(
      resourceRow({ status: 'deprecated', deprecationSeverity: 'hard' }) as never,
    );
    const check = vi.fn<LivenessCheck>();
    const result = await verifyDeadLink({ resourceId: 'res_1', reportId: 'rep_1', check });
    expect(check).not.toHaveBeenCalled();
    expect(applyReview).not.toHaveBeenCalled();
    expect(updateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rep_1' },
        data: expect.objectContaining({
          state: 'auto_resolved',
          resolution: 'resource already deprecated (hard severity)',
        }),
      }),
    );
    expect(result).toMatchObject({ outcome: 'already_deprecated', state: 'auto_resolved' });
  });

  it('a deprecated row with no recorded severity still resolves', async () => {
    findUnique.mockResolvedValue(
      resourceRow({ status: 'deprecated', deprecationSeverity: null }) as never,
    );
    const result = await run(dead);
    expect(result).toMatchObject({
      outcome: 'already_deprecated',
      detail: 'resource already deprecated (unspecified severity)',
    });
  });

  it('a resource that vanished between the route lookup and the probe stays open', async () => {
    findUnique.mockResolvedValue(null as never);
    const result = await run(dead);
    expect(updateReport).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'skipped', state: 'open' });
  });

  it('generated rows are reportable but never probed, and stay open for a human', async () => {
    findUnique.mockResolvedValue(resourceRow({ origin: 'generated' }) as never);
    const check = vi.fn<LivenessCheck>();
    const result = await verifyDeadLink({ resourceId: 'res_1', reportId: 'rep_1', check });
    expect(check).not.toHaveBeenCalled();
    expect(updateReport).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'skipped', state: 'open' });
  });

  it('a raced reject is logged, not thrown — the report keeps the verdict and stays open', async () => {
    applyReview.mockResolvedValue({ kind: 'raced' });
    const result = await run(dead);
    expect(updateReport).toHaveBeenCalledWith({
      where: { id: 'rep_1' },
      data: { resolution: 'http 404' },
    });
    expect(result).toMatchObject({ outcome: 'inconclusive', state: 'open' });
  });

  it('a probe that throws degrades to a recorded-but-unverified report', async () => {
    const result = await run(async () => {
      throw new Error('boom');
    });
    expect(result).toEqual({ outcome: 'skipped', state: 'open' });
  });
});
