// DB integration tests for the RemediationJob single-flight primitives (Phase
// 2.5f-1): claimRemediationJob / finishJob / reclaimStaleRemediationJobs. Real DB,
// no LLM. Audit 2.11(b), pulled forward with Block 3: this is the layer the 2.1
// reclaim-threshold fix turns on — the partial unique index
// `RemediationJob_active_per_path` is the hard backstop that keeps two workers
// from remediating the same Path concurrently, and it had zero coverage.
//
// Self-cleaning: Paths use a __verify_remjob__ topic prefix; deleting them
// cascades their RemediationJobs. Skips cleanly when DATABASE_URL is unset
// (describeDb). Run with the worker STOPPED — reclaimStaleRemediationJobs scans
// the whole table, and a live worker's own reclaim pass would race these rows.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { PathStatus, RemediationState } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  claimRemediationJob,
  finishJob,
  reclaimStaleRemediationJobs,
} from '@/lib/agents/track/remediation-job';
import { describeDb } from './db';

const MARK = '__verify_remjob__';

async function cleanup() {
  // Path deletion cascades RemediationJob (onDelete: Cascade).
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

const makePath = (suffix: string) =>
  prisma.path.create({
    data: { topic: `${MARK}${suffix}`, status: PathStatus.building },
    select: { id: true },
  });

const getJob = (id: string) => prisma.remediationJob.findUniqueOrThrow({ where: { id } });

describeDb('RemediationJob single-flight primitives', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('claim inserts a running job; a second claim on the same Path gets { busy }', async () => {
    const path = await makePath('claim');

    const first = await claimRemediationJob(path.id, ['hole-a']);
    expect(first.claimed).toBe(true);
    if (!first.claimed) return;
    expect(first.job.state).toBe(RemediationState.running);
    expect(first.job.claimedAt).not.toBeNull();
    expect(first.job.holeSlugs).toEqual(['hole-a']);

    // The P2002 path: the partial unique index rejects a second active job.
    const second = await claimRemediationJob(path.id, ['hole-b']);
    expect(second).toEqual({ claimed: false, busy: true });
  });

  it('CONCURRENT claims on one Path → exactly one winner (the index arbitrates, not app logic)', async () => {
    const path = await makePath('race');
    const results = await Promise.all([
      claimRemediationJob(path.id, ['hole']),
      claimRemediationJob(path.id, ['hole']),
      claimRemediationJob(path.id, ['hole']),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(2);
  });

  it('finishJob moves running → terminal and records the outcome', async () => {
    const path = await makePath('finish');
    const claim = await claimRemediationJob(path.id, ['hole-a', 'hole-b']);
    if (!claim.claimed) throw new Error('claim failed');

    const res = await finishJob(claim.job.id, {
      state: RemediationState.escalated,
      relaxedConceptSlugs: ['hole-a'],
      escalatedConceptSlugs: ['hole-b'],
    });
    expect(res.finished).toBe(true);

    const after = await getJob(claim.job.id);
    expect(after.state).toBe(RemediationState.escalated);
    expect(after.relaxedConceptSlugs).toEqual(['hole-a']);
    expect(after.escalatedConceptSlugs).toEqual(['hole-b']);

    // Terminal row no longer matches the partial index → the Path is claimable again.
    const reclaim = await claimRemediationJob(path.id, ['hole-b']);
    expect(reclaim.claimed).toBe(true);
  });

  it('finishJob refuses to resurrect a superseded (already-terminal) job', async () => {
    const path = await makePath('supersede');
    const original = await claimRemediationJob(path.id, ['hole']);
    if (!original.claimed) throw new Error('claim failed');

    // A --force claim terminates the original (state → failed) and takes the slot.
    const forced = await claimRemediationJob(path.id, ['hole'], { force: true });
    expect(forced.claimed).toBe(true);
    expect((await getJob(original.job.id)).state).toBe(RemediationState.failed);

    // The original job's late finish must no-op, not flip failed → succeeded.
    const late = await finishJob(original.job.id, { state: RemediationState.succeeded });
    expect(late.finished).toBe(false);
    expect((await getJob(original.job.id)).state).toBe(RemediationState.failed);
  });

  it('reclaimStaleRemediationJobs fails only past-cutoff running jobs, freeing the slot', async () => {
    const stalePath = await makePath('stale');
    const freshPath = await makePath('fresh');

    const stale = await claimRemediationJob(stalePath.id, ['hole']);
    const fresh = await claimRemediationJob(freshPath.id, ['hole']);
    if (!stale.claimed || !fresh.claimed) throw new Error('claim failed');
    // Age the stale claim past the cutoff we'll reclaim with.
    await prisma.remediationJob.update({
      where: { id: stale.job.id },
      data: { claimedAt: new Date(Date.now() - 10 * 60_000) },
    });

    await reclaimStaleRemediationJobs(5 * 60_000); // asserts on MY rows, not the global count

    const staleAfter = await getJob(stale.job.id);
    const freshAfter = await getJob(fresh.job.id);
    expect(staleAfter.state).toBe(RemediationState.failed); // past cutoff → reclaimed
    expect(staleAfter.error).toContain('stale claim');
    expect(freshAfter.state).toBe(RemediationState.running); // within cutoff → a LIVE job is left alone

    // The reclaim freed the partial unique index: the Path is claimable again.
    const next = await claimRemediationJob(stalePath.id, ['hole']);
    expect(next.claimed).toBe(true);
  });
});
