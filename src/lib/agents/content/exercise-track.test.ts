// Unit tests for pickStratified (Phase 2.5h-4) — pure, deterministic (seeded rng):
// coverage guarantee, no-replacement, breadth-first, respects n. No LLM, no DB. Migrated
// from Part A of scripts/verify/2_5h_4_exercises.ts (R2); the live exercise-track half
// stays in that script.
import { describe, it, expect, vi } from 'vitest';

// exercise-track.ts imports @/lib/db (used by the live exerciseTrack path), which throws
// at module-eval without DATABASE_URL. pickStratified is pure, so stub the DB.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { pickStratified } from '@/lib/agents/content/exercise-track';

// mulberry32 seeded PRNG for deterministic sampling.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('pickStratified', () => {
  it('breadth-first, no-replacement: sample 4 from two full groups → 2 + 2', () => {
    const A = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const B = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const s = pickStratified([A, B], 4, rng(7));
    expect(s.length).toBe(4);
    expect(s.filter((x) => x.startsWith('a')).length).toBe(2);
    expect(s.filter((x) => x.startsWith('b')).length).toBe(2);
    expect(new Set(s).size).toBe(4); // no replacement
  });

  it('coverage: n >= group count → every non-empty group represented', () => {
    const cov = pickStratified([['x'], ['y1', 'y2'], ['z1', 'z2', 'z3']], 4, rng(3));
    expect(cov).toContain('x');
    expect(cov.some((q) => q.startsWith('y'))).toBe(true);
    expect(cov.some((q) => q.startsWith('z'))).toBe(true);
  });

  it('overdraw: fewer available than n → return all, no padding/dupes', () => {
    const few = pickStratified([['p'], ['q']], 5, rng(1));
    expect(few.length).toBe(2);
    expect(new Set(few).size).toBe(2);
  });

  it('empty groups → empty sample', () => {
    expect(pickStratified([], 4, rng(1)).length).toBe(0);
  });
});
