// Unit tests for the A4 eviction threshold predicate. Pure — no DB (the leaf
// stubs keep the transitive @/lib/db import from throwing; CLAUDE.md § module-
// eval gotcha). The effectful path (applyPendingReview reject) is 2.5g-5
// machinery with its own coverage; what A4 owns is WHEN it fires.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { shouldEvict } from '@/lib/curation/evict-low-trust';
import { computeTrustScore } from '@/lib/curation/trust-score';
import { voteSignal } from '@/lib/curation/vote-signal';
import { TRUST_EVICT_FLOOR, TRUST_EVICT_MIN_VOTES, TRUST_FLOOR } from '@/lib/config';

const active = { status: 'active', origin: 'agent' };
// trust as the vote route would recompute it: prior + votes only (no YT stats).
const trustOf = (base: number, likes: number, dislikes: number) => {
  const sig = voteSignal(likes, dislikes);
  return computeTrustScore({ base, signals: sig ? [sig] : [] });
};
const verdict = (base: number, likes: number, dislikes: number, over: Partial<typeof active> = {}) =>
  shouldEvict({ ...active, ...over, trustScore: trustOf(base, likes, dislikes), likes, dislikes });

describe('shouldEvict — threshold predicate (A4)', () => {
  it('config sanity: evict floor sits well above the recompute clamp', () => {
    expect(TRUST_EVICT_FLOOR).toBeGreaterThan(TRUST_FLOOR);
    expect(TRUST_EVICT_MIN_VOTES).toBeGreaterThanOrEqual(2);
  });

  it('0.5-prior + 5 unanimous dislikes → evict (the intended bite)', () =>
    expect(verdict(0.5, 0, 5)).toBe(true));

  it('0.5-prior + 4 dislikes 1 like at n=5 → still evict', () =>
    expect(verdict(0.5, 1, 4)).toBe(true));

  it('drive-by pair is harmless: 2 unanimous dislikes score under the floor but miss MIN_VOTES', () => {
    expect(trustOf(0.5, 0, 2)).toBeLessThan(TRUST_EVICT_FLOOR); // would fire without the bar
    expect(verdict(0.5, 0, 2)).toBe(false);
  });

  it('0.8-prior resists: 20 unanimous dislikes stay above the floor', () =>
    expect(verdict(0.8, 0, 20)).toBe(false));

  it('0.8-prior eventually falls to overwhelming consensus (~45+)', () => {
    expect(verdict(0.8, 0, 40)).toBe(false); // 0.5023 — still just above the floor
    expect(verdict(0.8, 0, 60)).toBe(true);
  });

  it('positive/mixed consensus never evicts regardless of count', () => {
    expect(verdict(0.5, 50, 0)).toBe(false);
    expect(verdict(0.5, 30, 30)).toBe(false);
  });

  it('generated rows are votable but never evictable', () =>
    expect(verdict(0.5, 0, 50, { origin: 'generated' })).toBe(false));

  it('non-active rows skip (idempotent re-entry)', () =>
    expect(verdict(0.5, 0, 50, { status: 'deprecated' })).toBe(false));
});
