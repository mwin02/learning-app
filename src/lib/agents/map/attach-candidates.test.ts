// Unit tests for candidate hygiene + ranking: capCandidates (merged-set count cap, no
// floor) and selectAttachable (fresh-judge admission with the coverage floor). No DB,
// no LLM. Consolidates scripts/verify-attach.ts, verify-scope-ranking.ts,
// verify-trust-ranking.ts, and Part A of verify/symmetric_duration_factor.ts (R2).
//
// Both functions read only role/coverageScore/trustScore/durationMin and pass the
// candidate objects through, so the identifier field is arbitrary; these tests use
// `resourceId`.
import { describe, it, expect, vi } from 'vitest';
import { ConceptResourceRole } from '@prisma/client';

// attach-candidates.ts transitively imports tools/search-resources → @/lib/db +
// @/lib/ai/models (→ vertex), both of which throw at module-eval without their env vars.
// capCandidates/selectAttachable are pure and never touch either, so stub them to keep
// this in the unit project.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/models', () => ({ getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }) }));

import { capCandidates, selectAttachable } from '@/lib/agents/map/attach-candidates';
import {
  MAP_MAX_CANDIDATES_PER_CONCEPT,
  MAP_ATTACH_MIN_COVERAGE,
  MAP_DURATION_RANKING,
  MAX_ATTACHABLE_DURATION_MIN,
} from '@/lib/config';

type Cand = {
  resourceId: string;
  role: ConceptResourceRole;
  coverageScore: number;
  trustScore?: number;
  durationMin?: number;
};
const teach = (resourceId: string, coverageScore: number, extra: Partial<Cand> = {}): Cand => ({
  resourceId,
  role: ConceptResourceRole.teaches,
  coverageScore,
  ...extra,
});
const use = (resourceId: string, coverageScore: number, extra: Partial<Cand> = {}): Cand => ({
  resourceId,
  role: ConceptResourceRole.uses,
  coverageScore,
  ...extra,
});
const ids = (cs: Cand[]) => cs.map((c) => c.resourceId);
const CAP = MAP_MAX_CANDIDATES_PER_CONCEPT;

describe('selectAttachable — admission filter (floor + cap)', () => {
  it('drops below-floor candidate', () => {
    const out = selectAttachable([use('a', 0.9), use('b', MAP_ATTACH_MIN_COVERAGE - 0.05), teach('c', 0.6)]);
    expect(ids(out)).not.toContain('b');
  });
  it('caps to MAX', () => {
    const many = Array.from({ length: CAP + 4 }, (_, i) => use(`u${i}`, 0.9 - i * 0.01));
    expect(selectAttachable(many).length).toBe(CAP);
  });
  it('retains a qualifying teaches even when CAP higher-coverage uses crowd it out', () => {
    const crowd = [...Array.from({ length: CAP }, (_, i) => use(`u${i}`, 1.0)), teach('t', 0.55)];
    expect(ids(selectAttachable(crowd))).toContain('t');
  });
  it('floor empties an all-sub-floor FRESH set', () => {
    const subFloor = Array.from({ length: CAP + 2 }, (_, i) => use(`s${i}`, 0.2 + i * 0.005));
    expect(selectAttachable(subFloor).length).toBe(0);
  });
});

describe('capCandidates — merged-set bound (count-only, NO floor)', () => {
  it('does NOT empty an all-sub-floor merged set, and never floors', () => {
    // THE FIX: the same all-sub-floor set, re-capped over persisted rows, is NOT
    // emptied — capCandidates keeps CAP of them, so a relaxed concept resting on
    // sub-floor candidates can never be wiped (which would regress readiness).
    const subFloor = Array.from({ length: CAP + 2 }, (_, i) => use(`s${i}`, 0.2 + i * 0.005));
    const capped = capCandidates(subFloor);
    expect(capped.length).toBe(CAP);
    expect(capped.every((c) => c.coverageScore < MAP_ATTACH_MIN_COVERAGE)).toBe(true);
  });
  it('no-op when at/under cap', () => {
    const mixed = [use('hi1', 0.95), use('hi2', 0.9), teach('lo', 0.1)];
    expect(capCandidates(mixed).length).toBe(3);
  });
  it('retains a qualifying teaches under cap (no floor)', () => {
    const crowd = [...Array.from({ length: CAP }, (_, i) => use(`u${i}`, 1.0)), teach('t', 0.55), use('x', 0.05)];
    expect(ids(capCandidates(crowd))).toContain('t');
  });
  it('single candidate survives', () => expect(capCandidates([use('only', 0.01)]).length).toBe(1));
  it('empty in → empty out', () => expect(capCandidates([]).length).toBe(0));
});

describe('duration ranking — scope-aware (orders, never gates)', () => {
  it('default regime: a scoped 30m lesson outranks an over-long 3h chapter', () => {
    const out = capCandidates([teach('chapter-3h', 0.9, { durationMin: 180 }), teach('scoped-30m', 0.75, { durationMin: 30 })]);
    expect(ids(out)[0]).toBe('scoped-30m');
  });
  it('an over-long resource is kept when it is the only candidate', () => {
    const out = selectAttachable([teach('only-3h', 0.9, { durationMin: 180 })]);
    expect(ids(out)).toContain('only-3h');
  });
  it('modest overrun is NOT over-penalized: a strong 90m lesson still beats a shallow 10m one', () => {
    const out = capCandidates([teach('lecture-90m', 0.95, { durationMin: 90 }), teach('shallow-10m', 0.5, { durationMin: 10 })]);
    expect(ids(out)[0]).toBe('lecture-90m');
  });
  it('on-ramp regime is STRICTER than default', () => {
    const cands = [teach('full-course-2h', 0.95, { durationMin: 120 }), teach('orientation-15m', 0.7, { durationMin: 15 })];
    expect(ids(capCandidates(cands, { isOnRamp: true }))[0]).toBe('orientation-15m');
    // Same inputs under the default regime: 120 min is under the default span tail, so
    // the high-coverage course is NOT demoted enough to lose — proving the regimes differ.
    expect(ids(capCandidates(cands))[0]).toBe('full-course-2h');
  });
  it('duration never GATES: sub-floor coverage still dropped, over-long relevant kept', () => {
    const out = selectAttachable([teach('relevant-long', 0.7, { durationMin: 240 }), teach('short-irrelevant', 0.2, { durationMin: 5 })]);
    expect(ids(out)).not.toContain('short-irrelevant');
    expect(ids(out)).toContain('relevant-long');
  });
  it('a qualifying primary survives the cap despite duration demotion', () => {
    const fillers = Array.from({ length: 6 }, (_, i) => use(`f${i}`, 0.9, { durationMin: 10 }));
    const primary = teach('primary-long', 0.6, { durationMin: 200 });
    expect(ids(capCandidates([...fillers, primary]))).toContain('primary-long');
  });
  it('no durationMin → pure coverage order (back-compat)', () => {
    const out = capCandidates([teach('a', 0.5), teach('b', 0.9), teach('c', 0.7)]);
    expect(ids(out).join(',')).toBe('b,c,a');
  });
  it('factor curve sanity: at-target outranks a fully-decayed long one; floor in (0,1)', () => {
    const { targetMin, spanMin, floor } = MAP_DURATION_RANKING.default;
    const out = capCandidates([teach('at-target', 0.8, { durationMin: targetMin }), teach('past-span', 0.8, { durationMin: targetMin + spanMin })]);
    expect(ids(out)[0]).toBe('at-target');
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(1);
  });
});

describe('trust blend in ranking (orders; coverage stays the only gate)', () => {
  it('trust breaks a coverage tie', () => {
    const out = selectAttachable([teach('lo', 0.8, { trustScore: 0.5 }), teach('hi', 0.8, { trustScore: 0.95 })]);
    expect(ids(out)[0]).toBe('hi');
  });
  it('trust can flip a near-coverage tie', () => {
    // cov 0.60 / trust 0.95 → 0.705  vs  cov 0.65 / trust 0.40 → 0.575
    const out = selectAttachable([teach('lowcov-hitrust', 0.6, { trustScore: 0.95 }), teach('hicov-lotrust', 0.65, { trustScore: 0.4 })]);
    expect(ids(out)[0]).toBe('lowcov-hitrust');
  });
  it('coverage is still the only GATE: sub-floor dropped despite 0.99 trust', () => {
    const out = selectAttachable([teach('great', 0.7, { trustScore: 0.5 }), teach('irrelevant', 0.2, { trustScore: 0.99 })]);
    expect(ids(out)).not.toContain('irrelevant');
  });
  it('the only qualifying primary survives the cap despite low trust', () => {
    const fillers = Array.from({ length: 6 }, (_, i) => use(`f${i}`, 0.9, { trustScore: 0.95 }));
    const primary = teach('primary', 0.55, { trustScore: 0.2 });
    expect(ids(capCandidates([...fillers, primary]))).toContain('primary');
  });
  it('no trustScore → pure coverage order (back-compat)', () => {
    const out = capCandidates([teach('a', 0.5), teach('b', 0.9), teach('c', 0.7)]);
    expect(ids(out).join(',')).toBe('b,c,a');
  });
});

describe('symmetric (short-end) duration penalty', () => {
  // A thin clip with a HIGHER blend than a longer teacher. Without a short-end penalty
  // the thin one would rank first; the penalty must flip it (default regime only).
  const thin = teach('thin', 0.95, { trustScore: 0.9, durationMin: 1 });
  const long = teach('long', 0.85, { trustScore: 0.7, durationMin: 11 });

  it('default: longer teacher outranks a higher-blend thin clip', () => {
    expect(capCandidates([thin, long])[0].resourceId).toBe('long');
  });
  it('onRamp: thin clip not penalized (orientation should be short)', () => {
    expect(capCandidates([thin, long], { isOnRamp: true })[0].resourceId).toBe('thin');
  });
  it('boundary: 5-min (healthy band) outranks an equal-blend 1-min clip', () => {
    const five = teach('five', 0.8, { trustScore: 0.8, durationMin: 5 });
    const one = teach('one', 0.8, { trustScore: 0.8, durationMin: 1 });
    expect(capCandidates([one, five])[0].resourceId).toBe('five');
  });
  it('null duration unpenalized: outranks an equal-blend thin clip', () => {
    const nul = teach('null', 0.8, { trustScore: 0.8 });
    const one = teach('one', 0.8, { trustScore: 0.8, durationMin: 1 });
    expect(capCandidates([one, nul])[0].resourceId).toBe('null');
  });
});

describe('attachable duration ceiling (Block 0 — admission drop in selectAttachable only)', () => {
  const over = MAX_ATTACHABLE_DURATION_MIN + 1;

  it('drops an over-ceiling candidate from fresh judge output', () => {
    const out = selectAttachable([teach('ok', 0.8, { durationMin: 60 }), teach('monster', 0.95, { durationMin: over })]);
    expect(ids(out)).toEqual(['ok']);
  });
  it('can empty a concept whose only candidate is over-ceiling (a hole beats a whole-course attachment)', () => {
    expect(selectAttachable([teach('monster', 0.95, { durationMin: over })]).length).toBe(0);
  });
  it('admits exactly at the ceiling', () => {
    const out = selectAttachable([teach('edge', 0.8, { durationMin: MAX_ATTACHABLE_DURATION_MIN })]);
    expect(ids(out)).toEqual(['edge']);
  });
  it('passes rows without a durationMin (like trust-less rows)', () => {
    const out = selectAttachable([teach('nodur', 0.8)]);
    expect(ids(out)).toEqual(['nodur']);
  });
  it('capCandidates does NOT drop over-ceiling rows (re-cap never re-litigates admission)', () => {
    const out = capCandidates([teach('monster', 0.95, { durationMin: over })]);
    expect(ids(out)).toEqual(['monster']);
  });
});
