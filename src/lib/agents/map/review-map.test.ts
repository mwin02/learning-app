// Unit tests for the pure map-review core (Pre-Freeze Map Review, Block 1).
// No DB, no LLM — the detectors, similarity heuristic, and finding normalization.
import { describe, it, expect } from 'vitest';
import { ConceptMembership, ConceptResourceRole } from '@prisma/client';
import {
  detectHollowConcepts,
  detectDuplicationCandidates,
  normalizeTokens,
  normalizeLlmFindings,
  dedupeFindings,
  choosePrimary,
  type MapConcept,
} from '@/lib/agents/map/review-map';

const spine = ConceptMembership.spine;
const frontier = ConceptMembership.frontier;
const teaches = ConceptResourceRole.teaches;
const uses = ConceptResourceRole.uses;

function concept(over: Partial<MapConcept> & { slug: string }): MapConcept {
  return {
    title: over.title ?? over.slug,
    membership: spine,
    primaryRelaxed: false,
    ...over,
  };
}

describe('normalizeTokens', () => {
  it('lowercases, splits, singularizes plurals', () => {
    expect([...normalizeTokens('Database Views')].sort()).toEqual(['database', 'view']);
  });
  it('drops stopwords and short tokens', () => {
    expect([...normalizeTokens('Introduction to the Basic Joins')]).toEqual(['join']);
  });
  it('honors caller-supplied stop tokens (the topic word)', () => {
    expect([...normalizeTokens('SQL Views', new Set(['sql']))]).toEqual(['view']);
  });
});

describe('detectDuplicationCandidates (the sql `views` triplication)', () => {
  const concepts = [
    { slug: 'database-views', title: 'Database Views' },
    { slug: 'sql-views', title: 'SQL Views' },
    { slug: 'sql-view-use-cases', title: 'SQL View Use Cases' },
    { slug: 'joins', title: 'Joins' },
    { slug: 'indexes', title: 'Indexes' },
  ];
  const candidates = detectDuplicationCandidates(concepts, 'sql');
  const pairs = new Set(candidates.map((c) => [c.a, c.b].sort().join('~')));

  it('flags the view concepts as candidates', () => {
    expect(pairs.has('database-views~sql-views')).toBe(true);
    expect(pairs.has('sql-view-use-cases~sql-views')).toBe(true);
  });
  it('does not flag unrelated concepts', () => {
    expect(pairs.has('joins~indexes')).toBe(false);
    expect([...pairs].some((p) => p.includes('joins'))).toBe(false);
  });
  it('is sorted most-similar first and deterministic', () => {
    const sims = candidates.map((c) => c.similarity);
    expect([...sims]).toEqual([...sims].sort((a, b) => b - a));
    expect(detectDuplicationCandidates(concepts, 'sql')).toEqual(candidates);
  });
  it('respects the threshold', () => {
    expect(detectDuplicationCandidates(concepts, 'sql', 0.99)).toEqual([]);
  });
});

describe('detectHollowConcepts', () => {
  it('flags a relaxed concept always', () => {
    const f = detectHollowConcepts([
      concept({ slug: 'recursion', primaryRelaxed: true, primary: { title: 'X', role: uses, coverageScore: 0.4 } }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('hollow');
    expect(f[0].conceptSlugs).toEqual(['recursion']);
  });
  it('flags a non-relaxed primary below the coverage floor', () => {
    const f = detectHollowConcepts([
      concept({ slug: 'aggregates', primary: { title: 'Y', role: teaches, coverageScore: 0.55 } }),
    ]);
    expect(f.map((x) => x.conceptSlugs[0])).toEqual(['aggregates']);
  });
  it('does not flag a healthy primary', () => {
    expect(
      detectHollowConcepts([concept({ slug: 'joins', primary: { title: 'Z', role: teaches, coverageScore: 0.85 } })]),
    ).toEqual([]);
  });
  it('does not flag a concept with no primary (that is a hole, not hollow)', () => {
    expect(detectHollowConcepts([concept({ slug: 'extra', membership: frontier })])).toEqual([]);
  });
  it('does not flag a FRONTIER concept (hollow is spine-only; frontier never gates)', () => {
    // Same low-coverage / relaxed primaries that WOULD flag a spine concept, but on
    // a frontier node — supplementary, never part of readiness, so it's noise.
    expect(
      detectHollowConcepts([
        concept({ slug: 'extra-low', membership: frontier, primary: { title: 'Y', role: teaches, coverageScore: 0.55 } }),
        concept({ slug: 'extra-relaxed', membership: frontier, primaryRelaxed: true, primary: { title: 'X', role: uses, coverageScore: 0.4 } }),
      ]),
    ).toEqual([]);
  });
  it('honors a custom threshold', () => {
    const c = [concept({ slug: 'aggregates', primary: { title: 'Y', role: teaches, coverageScore: 0.55 } })];
    expect(detectHollowConcepts(c, 0.5)).toEqual([]);
  });
});

describe('choosePrimary', () => {
  it('prefers the highest-coverage teaches over a higher-coverage uses', () => {
    const p = choosePrimary([
      { title: 'uses-hi', role: uses, coverageScore: 0.9 },
      { title: 'teaches-lo', role: teaches, coverageScore: 0.5 },
      { title: 'teaches-hi', role: teaches, coverageScore: 0.7 },
    ]);
    expect(p).toEqual({ title: 'teaches-hi', role: teaches, coverageScore: 0.7 });
  });
  it('falls back to the best candidate when none teaches (relaxed)', () => {
    const p = choosePrimary([{ title: 'only-uses', role: uses, coverageScore: 0.4 }]);
    expect(p?.title).toBe('only-uses');
  });
  it('returns undefined for an unresourced concept', () => {
    expect(choosePrimary([])).toBeUndefined();
  });
});

describe('normalizeLlmFindings', () => {
  const valid = new Set(['sql-views', 'database-views', 'joins']);

  it('keeps a valid duplication with two known slugs', () => {
    const f = normalizeLlmFindings(
      [{ kind: 'duplication', conceptSlugs: ['sql-views', 'database-views'], message: 'merge into database-views' }],
      valid,
    );
    expect(f).toHaveLength(1);
    expect(f[0].conceptSlugs.sort()).toEqual(['database-views', 'sql-views']);
  });
  it('drops a duplication with fewer than two known slugs', () => {
    expect(
      normalizeLlmFindings(
        [{ kind: 'duplication', conceptSlugs: ['sql-views', 'ghost'], message: 'x' }],
        valid,
      ),
    ).toEqual([]);
  });
  it('drops hollow (the model must not emit it) and unknown kinds', () => {
    expect(
      normalizeLlmFindings(
        [
          { kind: 'hollow', conceptSlugs: ['joins'], message: 'x' },
          { kind: 'nonsense', conceptSlugs: ['joins'], message: 'x' },
        ],
        valid,
      ),
    ).toEqual([]);
  });
  it('keeps a granularity with one known slug and dedupes repeats', () => {
    const f = normalizeLlmFindings(
      [
        { kind: 'granularity', conceptSlugs: ['joins'], message: 'split it' },
        { kind: 'granularity', conceptSlugs: ['joins'], message: 'split it again' },
      ],
      valid,
    );
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('granularity');
  });
  it('drops findings with a blank message', () => {
    expect(
      normalizeLlmFindings([{ kind: 'granularity', conceptSlugs: ['joins'], message: '   ' }], valid),
    ).toEqual([]);
  });
});

describe('dedupeFindings', () => {
  it('collapses same-kind, same-concept-set findings across passes', () => {
    const f = dedupeFindings([
      { kind: 'duplication', conceptSlugs: ['sql-views', 'database-views'], message: 'a' },
      { kind: 'duplication', conceptSlugs: ['database-views', 'sql-views'], message: 'b' },
      { kind: 'hollow', conceptSlugs: ['sql-views'], message: 'c' },
    ]);
    expect(f).toHaveLength(2);
  });
});
