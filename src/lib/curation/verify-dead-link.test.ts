// Unit tests for R2's dead-link probe. The liveness checker is INJECTED, so the
// three verdict branches are exercised with no network; Prisma and
// applyPendingReview are stubbed (module-eval gotcha — @/lib/db validates env at
// import). The reject machinery itself is 2.5g-5's and has its own coverage;
// what R2 owns is WHICH verdict acts and what the report row ends up saying.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    resource: { findUnique: vi.fn(), updateMany: vi.fn() },
    resourceReport: { update: vi.fn() },
  },
}));
vi.mock('@/lib/curation/pending-review', () => ({ applyPendingReview: vi.fn() }));

import { DeprecationSeverity } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { verifyDeadLink, type LivenessCheck } from '@/lib/curation/verify-dead-link';

const findUnique = vi.mocked(prisma.resource.findUnique);
const updateResource = vi.mocked(prisma.resource.updateMany);
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
  updateResource.mockResolvedValue({ count: 1 } as never);
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

  it('an already hard-deprecated row auto-resolves without any network call', async () => {
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

  // F1c. `soft` is the severity evict-low-trust.ts writes for a DISLIKED resource,
  // which asserts nothing about liveness — so a soft row that 404s is a genuine
  // new finding, not a settled one, and it needs `hard` for the Track-patching
  // layer to see it. applyPendingReview can't do it: its reject only matches
  // pending_review/active rows.
  // The escalation clause enumerates the non-`hard` severities POSITIVELY, because
  // `{ not: 'hard' }` compiles to a SQL inequality and cannot match NULL. That
  // inverts the drift risk: the terser form would have auto-covered a new enum
  // member, whereas the OR silently stops matching it — and a deprecated + <new>
  // dead row would go back to closing with a false "already deprecated". Adding a
  // member has to fail here first.
  it('has an escalation clause covering every non-hard severity', () => {
    expect(Object.values(DeprecationSeverity)).toEqual(['soft', 'hard']);
  });

  it('a soft-deprecated row that is authoritatively dead is escalated to hard', async () => {
    findUnique.mockResolvedValue(
      resourceRow({ status: 'deprecated', deprecationSeverity: 'soft' }) as never,
    );
    const result = await run(dead);
    expect(applyReview).not.toHaveBeenCalled();
    expect(updateResource).toHaveBeenCalledWith({
      where: {
        id: 'res_1',
        status: 'deprecated',
        OR: [{ deprecationSeverity: 'soft' }, { deprecationSeverity: null }],
      },
      data: { deprecationSeverity: 'hard' },
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

  it('a soft-deprecated row the probe finds alive keeps its severity', async () => {
    findUnique.mockResolvedValue(
      resourceRow({ status: 'deprecated', deprecationSeverity: 'soft' }) as never,
    );
    const result = await run(alive);
    expect(updateResource).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'appears_live', state: 'open' });
  });

  // Nothing recorded a liveness verdict on this row, so "already deprecated" would
  // be an assertion no one made. Probe, and supply the severity that is missing.
  //
  // Prisma is mocked here, so this can only show that the probe RUNS and that the
  // escalation is attempted — a where-clause that selects no row would still pass.
  // Whether the clause actually matches a NULL-severity row is the whole question
  // (`{ not: 'hard' }` compiled to a SQL inequality and matched none of them), and
  // it is settled against the real DB in tests/integration/dead-link-escalation.
  it('a deprecated row with no recorded severity is probed, not assumed settled', async () => {
    findUnique.mockResolvedValue(
      resourceRow({ status: 'deprecated', deprecationSeverity: null }) as never,
    );
    const check = vi.fn<LivenessCheck>().mockResolvedValue({ alive: false, reason: 'http 404' });
    const result = await verifyDeadLink({ resourceId: 'res_1', reportId: 'rep_1', check });
    expect(check).toHaveBeenCalledWith('https://example.com/gone');
    expect(updateResource).toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'confirmed_dead', state: 'auto_resolved' });
  });

  // F1c. pending_review is not a settled defect — the row is still selectable
  // (search-resources.ts's DEFAULT_STATUSES) and still sits in persisted Paths, so
  // closing the report with "already deprecated" would be false and would leave a
  // dead row eligible for approval into learner paths.
  it('a pending_review row is probed and rejected like an active one', async () => {
    findUnique.mockResolvedValue(resourceRow({ status: 'pending_review' }) as never);
    const result = await run(dead);
    expect(applyReview).toHaveBeenCalledWith({
      action: 'reject',
      resourceId: 'res_1',
      severity: 'hard',
      cascade: false,
    });
    expect(result).toMatchObject({ outcome: 'confirmed_dead', state: 'auto_resolved' });
  });

  it('a pending_review row the probe finds alive is never auto-resolved', async () => {
    findUnique.mockResolvedValue(resourceRow({ status: 'pending_review' }) as never);
    const result = await run(alive);
    expect(updateReport).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'appears_live', state: 'open' });
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

  // F1d. Two learners hitting the same 404 inside the probe's 6s window: the loser
  // must not report a different outcome than the winner, and R4 must not inherit an
  // open report on a resource that is demonstrably settled.
  it('a raced reject re-reads the row and auto-resolves when someone else killed it', async () => {
    applyReview.mockResolvedValue({ kind: 'raced' });
    findUnique
      .mockResolvedValueOnce(resourceRow() as never)
      .mockResolvedValueOnce(
        resourceRow({ status: 'deprecated', deprecationSeverity: 'hard' }) as never,
      );
    const result = await run(dead);
    expect(updateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'auto_resolved',
          resolution: 'resource already deprecated (hard severity)',
        }),
      }),
    );
    expect(result).toMatchObject({ outcome: 'already_deprecated', state: 'auto_resolved' });
  });

  // The other half of `raced`: the row is still reviewable, so nothing settled it
  // and the probe's verdict is a real signal the operator should see.
  it('a raced reject on a still-reviewable row stamps the verdict and stays open', async () => {
    applyReview.mockResolvedValue({ kind: 'raced' });
    const result = await run(dead);
    expect(updateReport).toHaveBeenCalledWith({
      where: { id: 'rep_1' },
      data: { resolution: 'http 404' },
    });
    expect(result).toMatchObject({ outcome: 'inconclusive', state: 'open' });
  });

  it('a blocked reject leaves the report open with the probe verdict', async () => {
    applyReview.mockResolvedValue({ kind: 'blocked', decompositionStatus: 'pending' });
    const result = await run(dead);
    expect(result).toMatchObject({ outcome: 'inconclusive', state: 'open' });
  });

  // The escalation is conditional, so a concurrent writer that got to `hard` first
  // makes it a no-op — the report still ends settled, not open.
  it('a lost escalation race auto-resolves off the re-read row', async () => {
    findUnique
      .mockResolvedValueOnce(
        resourceRow({ status: 'deprecated', deprecationSeverity: 'soft' }) as never,
      )
      .mockResolvedValueOnce(
        resourceRow({ status: 'deprecated', deprecationSeverity: 'hard' }) as never,
      );
    updateResource.mockResolvedValue({ count: 0 } as never);
    const result = await run(dead);
    expect(result).toMatchObject({ outcome: 'already_deprecated', state: 'auto_resolved' });
  });

  it('a probe that throws degrades to a recorded-but-unverified report', async () => {
    const result = await run(async () => {
      throw new Error('boom');
    });
    expect(result).toEqual({ outcome: 'skipped', state: 'open' });
  });
});
