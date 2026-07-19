// Free-beta A1: learner up/down votes → trustScore evidence.
//
// Turns a resource's aggregate vote counts (ResourceRating rows) into an
// EvidenceSignal that the trust-score seam (trust-score.ts) blends onto the
// source prior — the "our own votes later" signal its header anticipated. See
// the TRUST_VOTES_* knobs in config.ts for the calibration rationale (Laplace-
// smoothed like share, confidence saturating in single-digit counts, weight
// above YouTube's).
//
// Pure + dependency-light (config only) so the colocated vote-signal.test.ts can
// exercise it without a DB. Callers (recomputeResourceTrust) supply the counts.

import { TRUST_VOTES_CONF_HALF, TRUST_VOTES_WEIGHT } from '@/lib/config';
import type { EvidenceSignal } from '@/lib/curation/trust-score';

const sane = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// The vote EvidenceSignal, or null when there are no votes — a null signal means
// "no evidence", so trustScore rests on the prior (and any YouTube signal).
export function voteSignal(likes: number, dislikes: number): EvidenceSignal | null {
  const up = sane(likes);
  const down = sane(dislikes);
  const n = up + down;
  if (n === 0) return null;

  return {
    // Laplace (Beta(1,1)) smoothing pulls thin evidence toward 0.5: one like is
    // 0.67, not certainty; unanimity only approaches 0/1 as n grows.
    value: (up + 1) / (n + 2),
    confidence: n / (n + TRUST_VOTES_CONF_HALF),
    weight: TRUST_VOTES_WEIGHT,
  };
}
