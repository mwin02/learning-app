// Throwaway verification for Phase 2.5h block 2a (the trustScore composition seam).
//   npx tsx --env-file=.env.local scripts/verify-trust-score.ts
//
// Pure fixtures only — no DB, no LLM. Exercises computeTrustScore against the
// worked examples agreed in design, plus the formula's invariants (no-signal →
// base, symmetric pull, confidence scaling, multi-signal averaging, clamping).
//
// Signal-specific knobs (TARGET_LIKE_RATIO, VIEW_SAT, WEIGHT_YT) land in block 2b;
// here we feed pre-computed { value, confidence, weight } terms directly so the
// blend math is verified in isolation.

import { computeTrustScore, type EvidenceSignal } from '../src/lib/curation/trust-score';
import { TRUST_FLOOR } from '../src/lib/config';

let failures = 0;
function approx(name: string, got: number, want: number, eps = 0.005) {
  const ok = Math.abs(got - want) <= eps;
  if (ok) console.log(`  ✓ ${name}  (${got.toFixed(3)})`);
  else {
    failures++;
    console.error(`  ✗ ${name}  got ${got.toFixed(3)}, want ${want.toFixed(3)}`);
  }
}
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

// A full-confidence, full-weight engagement signal at quality `v` — the shape
// block 2b will produce for a heavily-viewed YouTube video.
const eng = (value: number, confidence = 1, weight = 1): EvidenceSignal => ({ value, confidence, weight });

console.log('\n── no signal → clamped base (prior only) ──────────────────────');
approx('docs.python.org (base 0.95)', computeTrustScore({ base: 0.95 }), 0.95);
approx('unknown blog / web (base 0.40)', computeTrustScore({ base: 0.4 }), 0.4);
approx('empty signals array == no signals', computeTrustScore({ base: 0.7, signals: [] }), 0.7);

console.log('\n── single engagement signal, full confidence (P0=1, w=1) ──────');
// blended = (1·base + 1·v) / (1 + 1) = (base + v)/2
approx('unknown YT, base 0.5, v=1.0 (strong) → 0.75', computeTrustScore({ base: 0.5, signals: [eng(1.0)] }), 0.75);
approx('unknown YT, base 0.5, v=0.25 (weak)  → 0.375', computeTrustScore({ base: 0.5, signals: [eng(0.25)] }), 0.375);

console.log('\n── symmetry: a weak signal pulls a reputable source DOWN ──────');
const strangWeak = computeTrustScore({ base: 0.95, signals: [eng(0.25, 0.4)] });
approx('3b1b base 0.95, v=0.25 conf=0.4 → 0.75', strangWeak, 0.75);
check('weak signal lowered the prior (0.75 < 0.95)', strangWeak < 0.95, strangWeak);

console.log('\n── confidence scaling: thin evidence stays near base ──────────');
const thin = computeTrustScore({ base: 0.5, signals: [eng(1.0, 0.16)] });
approx('base 0.5, v=1.0 conf=0.16 → ~0.57', thin, 0.569);
check('low-confidence strong signal barely moved base', Math.abs(thin - 0.5) < 0.1, thin);
const modest = computeTrustScore({ base: 0.5, signals: [eng(1.0, 0.31)] });
approx('base 0.5, v=1.0 conf=0.31 → ~0.62', modest, 0.618);

console.log('\n── multi-signal: precision-weighted average (future votes) ────');
// e.g. engagement (v=1.0, p=1) + a downvoted user-vote term (v=0.2, p=0.5)
// blended = (1·0.5 + 1·1.0 + 0.5·0.2) / (1 + 1 + 0.5) = 1.6 / 2.5 = 0.64
approx(
  'base 0.5 + eng(1.0,p1) + vote(0.2,p0.5) → 0.64',
  computeTrustScore({ base: 0.5, signals: [eng(1.0), eng(0.2, 1, 0.5)] }),
  0.64,
);
const avg = computeTrustScore({ base: 0.5, signals: [eng(1.0), eng(0.2)] });
check('result stays within [min,max] of inputs (no overshoot)', avg >= 0.2 && avg <= 1.0, avg);

console.log('\n── inert + clamping ───────────────────────────────────────────');
approx('zero-confidence signal is inert → base', computeTrustScore({ base: 0.8, signals: [eng(0.0, 0)] }), 0.8);
approx('zero-weight signal is inert → base', computeTrustScore({ base: 0.8, signals: [eng(0.0, 1, 0)] }), 0.8);
approx('upper clamp: base 1, v=1 → 1.0', computeTrustScore({ base: 1, signals: [eng(1)] }), 1.0);
const floored = computeTrustScore({ base: 0.1, signals: [eng(0.0, 1, 1), eng(0.0, 1, 1)] });
check(`floor: heavily-disliked never below TRUST_FLOOR (${TRUST_FLOOR})`, floored >= TRUST_FLOOR, floored);
approx('out-of-range inputs clamped (base 2 → 1)', computeTrustScore({ base: 2 }), 1.0);

console.log(failures === 0 ? '\n✅ all trustScore checks passed\n' : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
