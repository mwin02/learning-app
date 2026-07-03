// Phase 2.5h (source-quality overhaul): the single trustScore composition seam.
//
// trustScore models "how much do we trust this resource" as a SOURCE-REPUTATION
// PRIOR moved by observable EVIDENCE. The prior is the matched Source's trustScore
// (curated in data/seed-sources.ts), or the blanket `web` row (0.4) for unknown
// domains. Evidence — YouTube engagement now (block 2b), our own up/down votes
// later — is expressed as EvidenceSignal terms that pull the score toward what the
// evidence says, weighted by how much evidence there is (confidence) and how much
// that signal is allowed to count (weight).
//
// The blend is a precision-weighted average, so it:
//   - degrades to `base` when there are no signals (docs, textbooks, articles);
//   - never overshoots outside [min, max] of {base, signal values};
//   - extends to a new signal by appending one more term — no rearchitecting
//     (the future vote system is just another EvidenceSignal).
//
// Movement is SYMMETRIC: a low-value, high-confidence signal can pull a reputable
// source's resource BELOW its prior (a poorly-received video from a great channel
// is genuinely weaker). `confidence` guards against acting on thin evidence.
//
// Pure and dependency-free so the colocated trust-score.test.ts can exercise the math
// without a DB. The only knobs are the prior strength and the floor (config.ts);
// signal-specific knobs (engagement thresholds, selection weight) live with their
// callers.

import { TRUST_PRIOR_STRENGTH, TRUST_FLOOR } from '@/lib/config';

// One piece of observable evidence about a resource's quality.
//   value      — what the evidence says the score should be, in [0, 1].
//   confidence — how much we believe this evidence, in [0, 1] (e.g. driven by
//                sample size: view count, vote count). Low confidence → the term
//                barely moves the prior.
//   weight     — how much this signal is allowed to count at full confidence, in
//                [0, 1]. Caps a single signal's influence so one viral-but-shallow
//                video can't fully override a 0.95 source.
export type EvidenceSignal = {
  value: number;
  confidence: number;
  weight: number;
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// Compose a trustScore from a source-reputation prior and zero or more evidence
// signals. Precision-weighted average: prior carries precision TRUST_PRIOR_STRENGTH;
// each signal carries precision confidence·weight. Result is clamped to
// [TRUST_FLOOR, 1] so trust never collapses to 0 (the minimal liveness floor lives
// at admission, in the sourcing prong — not here).
export function computeTrustScore(args: { base: number; signals?: EvidenceSignal[] }): number {
  const base = clamp01(args.base);
  const signals = args.signals ?? [];

  let numerator = TRUST_PRIOR_STRENGTH * base;
  let denominator = TRUST_PRIOR_STRENGTH;

  for (const s of signals) {
    const precision = clamp01(s.confidence) * clamp01(s.weight);
    if (precision <= 0) continue; // a zero-confidence or zero-weight signal is inert
    numerator += precision * clamp01(s.value);
    denominator += precision;
  }

  const blended = denominator > 0 ? numerator / denominator : base;
  return Math.min(1, Math.max(TRUST_FLOOR, blended));
}
