// Unit tests for the trustScore composition seam (Phase 2.5h block 2a). No DB, no LLM.
// Migrated from scripts/verify-trust-score.ts (R2).
//
// Exercises computeTrustScore against the worked design examples plus the formula's
// invariants (no-signal → base, symmetric pull, confidence scaling, multi-signal
// averaging, clamping). Signal-specific knobs are fed as pre-computed
// { value, confidence, weight } terms so the blend math is verified in isolation.
import { describe, it, expect } from 'vitest';
import { computeTrustScore, type EvidenceSignal } from '@/lib/curation/trust-score';
import { TRUST_FLOOR } from '@/lib/config';

// Faithful port of the script's approx() (|got - want| <= eps).
const close = (got: number, want: number, eps = 0.005) => expect(Math.abs(got - want)).toBeLessThanOrEqual(eps);

// A full-confidence, full-weight engagement signal at quality `v` — the shape block 2b
// produces for a heavily-viewed YouTube video.
const eng = (value: number, confidence = 1, weight = 1): EvidenceSignal => ({ value, confidence, weight });

describe('no signal → clamped base (prior only)', () => {
  it('docs.python.org (base 0.95)', () => close(computeTrustScore({ base: 0.95 }), 0.95));
  it('unknown blog / web (base 0.40)', () => close(computeTrustScore({ base: 0.4 }), 0.4));
  it('empty signals array == no signals', () => close(computeTrustScore({ base: 0.7, signals: [] }), 0.7));
});

describe('single engagement signal, full confidence (P0=1, w=1)', () => {
  // blended = (1·base + 1·v) / (1 + 1) = (base + v)/2
  it('unknown YT, base 0.5, v=1.0 (strong) → 0.75', () =>
    close(computeTrustScore({ base: 0.5, signals: [eng(1.0)] }), 0.75));
  it('unknown YT, base 0.5, v=0.25 (weak) → 0.375', () =>
    close(computeTrustScore({ base: 0.5, signals: [eng(0.25)] }), 0.375));
});

describe('symmetry: a weak signal pulls a reputable source DOWN', () => {
  const strangWeak = computeTrustScore({ base: 0.95, signals: [eng(0.25, 0.4)] });
  it('3b1b base 0.95, v=0.25 conf=0.4 → 0.75', () => close(strangWeak, 0.75));
  it('weak signal lowered the prior (0.75 < 0.95)', () => expect(strangWeak).toBeLessThan(0.95));
});

describe('confidence scaling: thin evidence stays near base', () => {
  const thin = computeTrustScore({ base: 0.5, signals: [eng(1.0, 0.16)] });
  it('base 0.5, v=1.0 conf=0.16 → ~0.57', () => close(thin, 0.569));
  it('low-confidence strong signal barely moved base', () => expect(Math.abs(thin - 0.5)).toBeLessThan(0.1));
  it('base 0.5, v=1.0 conf=0.31 → ~0.62', () =>
    close(computeTrustScore({ base: 0.5, signals: [eng(1.0, 0.31)] }), 0.618));
});

describe('multi-signal: precision-weighted average (future votes)', () => {
  // engagement (v=1.0, p=1) + a downvoted user-vote term (v=0.2, p=0.5)
  // blended = (1·0.5 + 1·1.0 + 0.5·0.2) / (1 + 1 + 0.5) = 1.6 / 2.5 = 0.64
  it('base 0.5 + eng(1.0,p1) + vote(0.2,p0.5) → 0.64', () =>
    close(computeTrustScore({ base: 0.5, signals: [eng(1.0), eng(0.2, 1, 0.5)] }), 0.64));
  it('result stays within [min,max] of inputs (no overshoot)', () => {
    const avg = computeTrustScore({ base: 0.5, signals: [eng(1.0), eng(0.2)] });
    expect(avg).toBeGreaterThanOrEqual(0.2);
    expect(avg).toBeLessThanOrEqual(1.0);
  });
});

describe('inert + clamping', () => {
  it('zero-confidence signal is inert → base', () =>
    close(computeTrustScore({ base: 0.8, signals: [eng(0.0, 0)] }), 0.8));
  it('zero-weight signal is inert → base', () =>
    close(computeTrustScore({ base: 0.8, signals: [eng(0.0, 1, 0)] }), 0.8));
  it('upper clamp: base 1, v=1 → 1.0', () => close(computeTrustScore({ base: 1, signals: [eng(1)] }), 1.0));
  it(`floor: heavily-disliked never below TRUST_FLOOR (${TRUST_FLOOR})`, () => {
    const floored = computeTrustScore({ base: 0.1, signals: [eng(0.0, 1, 1), eng(0.0, 1, 1)] });
    expect(floored).toBeGreaterThanOrEqual(TRUST_FLOOR);
  });
  it('out-of-range inputs clamped (base 2 → 1)', () => close(computeTrustScore({ base: 2 }), 1.0));
});
