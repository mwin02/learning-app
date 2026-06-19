// Phase 2.5f-1: the durable single-flight primitive for spine-hole remediation.
//
// A `building` Path (or a hard-deprecation regression) gets ONE active
// RemediationJob; concurrent claims are rejected. The claim is a DB ROW, not an
// advisory lock — remediation does 30–60s of LLM work, far longer than we can
// hold a transaction-scoped lock on Supabase's pooled connection (the same
// constraint ensurePathMap's two-phase claim works around). The partial unique
// index `RemediationJob_active_per_path` (state IN ('queued','running')) is the
// hard backstop: a second claim violates it → P2002 → { busy }.
//
// This block exposes the primitive only; the orchestration that runs between
// claim and finish is 2.5f-3, and the automatic poller / request-path enqueue
// that drive it are 2.5g. Until then the manual driver (2.5f-5) calls these.

import { Prisma, RemediationState, type RemediationJob } from '@prisma/client';
import { prisma } from '@/lib/db';
import { REMEDIATION_JOB_STALE_MS } from '@/lib/config';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export type ClaimResult =
  | { claimed: true; job: RemediationJob }
  // Another active job already holds this Path — caller should not spawn a second.
  | { claimed: false; busy: true };

// Claim the Path for remediation: insert a `running` job (claimedAt = now). Returns
// { busy } when an active job already exists (the partial unique index rejects the
// insert). `force` first terminates any existing active job — the manual driver's
// escape hatch for a stale claim (a worker that died mid-run); the proper
// stale-claim reclaim by age is 2.5g's poller, so we don't time-gate it here.
export async function claimRemediationJob(
  pathId: string,
  holeSlugs: string[],
  opts: { force?: boolean } = {},
): Promise<ClaimResult> {
  try {
    const job = await prisma.$transaction(async (tx) => {
      if (opts.force) {
        await tx.remediationJob.updateMany({
          where: { pathId, state: { in: [RemediationState.queued, RemediationState.running] } },
          data: { state: RemediationState.failed, error: 'superseded by --force claim' },
        });
      }
      return tx.remediationJob.create({
        data: { pathId, holeSlugs, state: RemediationState.running, claimedAt: new Date() },
      });
    });
    return { claimed: true, job };
  } catch (err) {
    if (isUniqueViolation(err)) return { claimed: false, busy: true };
    throw err;
  }
}

export type FinishInput = {
  state: Extract<
    RemediationState,
    'succeeded' | 'failed' | 'escalated'
  >;
  relaxedConceptSlugs?: string[];
  escalatedConceptSlugs?: string[];
  error?: string;
};

// Move a RUNNING job to a terminal state, recording what remediation did. A
// terminal row no longer matches the partial unique index, so the Path is free to
// be re-claimed later (a future regression or a retry).
//
// Guarded on state='running' (hence updateMany, not update — `update` needs a
// unique where and can't filter on state): if a concurrent `--force` claim already
// superseded this job (state→'failed'), this call must NOT resurrect it back to
// 'succeeded'/'escalated' and corrupt the audit trail. A no-op (count 0) means the
// job was already terminal; we log it rather than treat it as an error. Returns
// whether this call actually performed the transition.
export async function finishJob(jobId: string, input: FinishInput): Promise<{ finished: boolean }> {
  const { count } = await prisma.remediationJob.updateMany({
    where: { id: jobId, state: RemediationState.running },
    data: {
      state: input.state,
      ...(input.relaxedConceptSlugs ? { relaxedConceptSlugs: input.relaxedConceptSlugs } : {}),
      ...(input.escalatedConceptSlugs ? { escalatedConceptSlugs: input.escalatedConceptSlugs } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    },
  });
  if (count === 0) {
    console.warn('[remediation-job] finishJob no-op; job already terminal (superseded by --force?)', {
      jobId,
      attemptedState: input.state,
    });
  }
  return { finished: count > 0 };
}

// Phase 2.5g-3: stale-claim reclaim BY AGE — the automatic counterpart to the
// manual driver's --force. A job stuck `running` past the threshold is a worker
// that died mid-run (the claim row outlives the process). Fail it so it no longer
// matches the partial unique index `RemediationJob_active_per_path`, freeing the
// Path to be re-claimed by a fresh remediatePath (which recomputes holes from disk,
// so re-running is safe). The course worker calls this each poll cycle before
// claiming work. Returns how many jobs were reclaimed.
export async function reclaimStaleRemediationJobs(
  olderThanMs: number = REMEDIATION_JOB_STALE_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const { count } = await prisma.remediationJob.updateMany({
    where: { state: RemediationState.running, claimedAt: { lt: cutoff } },
    data: { state: RemediationState.failed, error: 'stale claim reclaimed by age (worker presumed dead)' },
  });
  if (count > 0) {
    console.warn('[remediation-job] reclaimed stale running jobs → failed', { count, cutoff });
  }
  return count;
}
