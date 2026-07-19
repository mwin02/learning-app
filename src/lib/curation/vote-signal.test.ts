// Unit tests for learner votes → trustScore (free-beta A1). Pure — no DB, no LLM.
// Pins the signal shape (Laplace smoothing, saturating confidence, weight knob) and
// the end-to-end blend behavior the A-blocks rely on: a lone vote nudges, consensus
// moves, and the unanimous-dislike asymptote that A4's evict floor is set against.
import { describe, it, expect } from 'vitest';
import { voteSignal } from '@/lib/curation/vote-signal';
import { computeTrustScore } from '@/lib/curation/trust-score';
import { TRUST_VOTES_CONF_HALF, TRUST_VOTES_WEIGHT } from '@/lib/config';

const close = (got: number, want: number, eps = 0.01) => expect(Math.abs(got - want)).toBeLessThanOrEqual(eps);
// trustScore for a resource given its source prior + vote counts (no YT signal).
const trust = (base: number, likes: number, dislikes: number): number => {
  const sig = voteSignal(likes, dislikes);
  return computeTrustScore({ base, signals: sig ? [sig] : [] });
};

describe('voteSignal shape', () => {
  it('no votes → null (no evidence, trust rests on the prior)', () =>
    expect(voteSignal(0, 0)).toBeNull());

  it('1 like is not certainty: value 0.67, low confidence', () => {
    const sig = voteSignal(1, 0)!;
    close(sig.value, 2 / 3);
    close(sig.confidence, 1 / (1 + TRUST_VOTES_CONF_HALF));
    expect(sig.weight).toBe(TRUST_VOTES_WEIGHT);
  });

  it('1 dislike mirrors it: value 0.33', () => close(voteSignal(0, 1)!.value, 1 / 3));

  it('even split stays neutral at any count', () => {
    close(voteSignal(1, 1)!.value, 0.5);
    close(voteSignal(50, 50)!.value, 0.5);
  });

  it('value is monotone in like share and approaches the extremes with n', () => {
    expect(voteSignal(9, 1)!.value).toBeGreaterThan(voteSignal(6, 4)!.value);
    close(voteSignal(98, 0)!.value, 0.99);
    close(voteSignal(0, 98)!.value, 0.01);
  });

  it('confidence saturates with total count (half point at TRUST_VOTES_CONF_HALF)', () => {
    close(voteSignal(3, 2)!.confidence, 0.5); // n = 5 = CONF_HALF
    close(voteSignal(10, 10)!.confidence, 0.8);
    expect(voteSignal(500, 500)!.confidence).toBeGreaterThan(0.98);
  });

  it('garbage counts (negative, NaN, fractional) are sanitized', () => {
    expect(voteSignal(-3, Number.NaN)).toBeNull();
    close(voteSignal(1.9, -2)!.value, voteSignal(1, 0)!.value); // floors to 1 like
  });
});

describe('blend behavior (computeTrustScore end-to-end)', () => {
  it('a lone dislike on a 0.8-prior resource only nudges (~0.76)', () =>
    close(trust(0.8, 0, 1), 0.76));

  it('sustained consensus moves it: 0/5 dislikes → 0.63, 0/20 → 0.53', () => {
    close(trust(0.8, 0, 5), 0.63);
    close(trust(0.8, 0, 20), 0.53);
  });

  // A4 calibration anchor: unanimous dislikes can drag a 0.8 prior to ≈0.47
  // (base/(1+weight)) at the limit but no further — TRUST_EVICT_FLOOR must sit
  // near/above ~0.5 to ever fire on votes alone.
  it('unanimous-dislike asymptote on a 0.8 prior floors near 0.47', () => {
    const limit = trust(0.8, 0, 10_000);
    close(limit, 0.47);
    expect(limit).toBeGreaterThan(0.45);
  });

  it('likes lift a low prior: 10/0 on the 0.4 web prior → ~0.56', () =>
    close(trust(0.4, 10, 0), 0.56));

  it('votes and the prior pull symmetrically around agreement', () =>
    close(trust(0.5, 5, 5), 0.5));
});
