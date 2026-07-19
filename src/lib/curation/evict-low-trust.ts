// Free-beta A4: automatic low-trust eviction — the vote-route policy that turns
// sustained negative consensus into removal.
//
// Deliberately a SEPARATE helper from recomputeResourceTrust: recompute stays a
// pure "rebuild the score" seam (a batch backfill calling it must never silently
// mass-evict); eviction is an explicit policy the vote route opts into, sync in
// the request (rare by construction: needs TRUST_EVICT_MIN_VOTES votes AND a
// sub-floor recompute).
//
// Execution reuses applyPendingReview reject (soft) — 2.5g-5's machinery gives
// deprecation + ConceptResource cleanup across every Path + bank staleness +
// readiness recompute in one transaction, and remediation refills any reopened
// hole. Nothing is deleted beyond candidate links: ResourceRating rows and the
// raw stats survive, so the future operator restore stays "flip status +
// re-judge" (see the free-beta plan § A4).
//
// Guard rails:
//   - only `active` rows (idempotent: an already-deprecated row skips; a
//     concurrent reject surfaces as applyPendingReview's `raced`, logged not
//     thrown);
//   - origin='generated' rows are votable but NEVER evicted (no external Source
//     reputation; evicting an authored on-ramp is nonsensical — settled A1/A4);
//   - eviction of some concept's only candidate is allowed (remediation's job),
//     but `pathsRegressed > 0` in the reject counters IS that case — logged at
//     warn so it's loud.

import { prisma } from '@/lib/db';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { log, logWarn } from '@/lib/log';
import { TRUST_EVICT_FLOOR, TRUST_EVICT_MIN_VOTES } from '@/lib/config';
import type { RecomputeTrustResult } from '@/lib/curation/recompute-trust';

// The pure threshold predicate, exported for unit tests: evict iff the resource
// is still active, isn't generated, has enough votes, and recomputed under the
// floor. `status`/`origin` are plain strings so tests don't need Prisma enums.
export function shouldEvict(args: {
  status: string;
  origin: string;
  trustScore: number;
  likes: number;
  dislikes: number;
}): boolean {
  return (
    args.status === 'active' &&
    args.origin !== 'generated' &&
    args.likes + args.dislikes >= TRUST_EVICT_MIN_VOTES &&
    args.trustScore < TRUST_EVICT_FLOOR
  );
}

export type EvictOutcome =
  | { evicted: false; reason: 'above-threshold' | 'not-active' | 'generated' | 'raced' | 'blocked' }
  | { evicted: true; conceptLinksRemoved: number; pathsRecomputed: number; pathsRegressed: number };

// Check the thresholds against a just-computed recompute result and, when they
// trip, execute the soft reject. Called by the vote route right after
// recomputeResourceTrust; returns what happened so the route (and logs) can say.
export async function maybeEvictLowTrust(
  resourceId: string,
  recompute: RecomputeTrustResult,
): Promise<EvictOutcome> {
  // Cheap pre-check on the score+votes alone before touching the DB again.
  if (
    recompute.likes + recompute.dislikes < TRUST_EVICT_MIN_VOTES ||
    recompute.trustScore >= TRUST_EVICT_FLOOR
  ) {
    return { evicted: false, reason: 'above-threshold' };
  }

  const row = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { status: true, origin: true },
  });
  if (!row || row.status !== 'active') return { evicted: false, reason: 'not-active' };
  if (row.origin === 'generated') return { evicted: false, reason: 'generated' };
  if (!shouldEvict({ ...row, ...recompute })) return { evicted: false, reason: 'above-threshold' };

  const result = await applyPendingReview({
    action: 'reject',
    resourceId,
    severity: 'soft',
    cascade: false,
  });
  if (result.kind !== 'rejected') {
    // Concurrent decision won (raced), or the row left the reviewable state
    // under us (blocked et al.) — the resource is no longer ours to evict.
    log('resource.trust-evict-skipped', { resourceId, result: result.kind });
    return { evicted: false, reason: result.kind === 'raced' ? 'raced' : 'blocked' };
  }

  const fields = {
    resourceId,
    trustScore: recompute.trustScore,
    likes: recompute.likes,
    dislikes: recompute.dislikes,
    conceptLinksRemoved: result.conceptLinksRemoved,
    pathsRecomputed: result.pathsRecomputed,
    pathsRegressed: result.pathsRegressed,
  };
  // A regressed Path means we evicted some spine concept's only candidate —
  // allowed (remediation refills the hole), but loud.
  if (result.pathsRegressed > 0) logWarn('resource.trust-evicted', fields);
  else log('resource.trust-evicted', fields);

  return {
    evicted: true,
    conceptLinksRemoved: result.conceptLinksRemoved,
    pathsRecomputed: result.pathsRecomputed,
    pathsRegressed: result.pathsRegressed,
  };
}
