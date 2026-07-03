// Unit tests for validateComposition + the composition-core primitives (Phase 2.5e-2).
// Deterministic invariants only — no LLM, no DB. Migrated from Part 1 of
// scripts/verify-composer.ts (R2); the live composer half stays in that script.
import { describe, it, expect } from 'vitest';
import { ConceptMembership, ConceptResourceRole, TrackIntent } from '@prisma/client';
import { validateComposition } from '@/lib/agents/track/validate-composition';
import {
  buildPrereqIndex,
  computeInclusion,
  assignConceptsToLessons,
  orderConceptSlugs,
} from '@/lib/agents/track/composition-core';
import type { ComposerInputConcept, ComposerResult } from '@/lib/agents/track/composer';
import type { OrderEdge } from '@/lib/agents/map/order';

// --- fixture map: a → b → f (a,b spine; f frontier) ----------------------
const concepts: ComposerInputConcept[] = [
  {
    slug: 'a', title: 'A', membership: ConceptMembership.spine, prerequisiteSlugs: [],
    candidates: [
      { resourceId: 'r-a1', role: ConceptResourceRole.teaches, coverageScore: 0.9, title: 'A teach', type: 'article', difficulty: 'beginner', durationMin: 30 },
      { resourceId: 'r-a2', role: ConceptResourceRole.uses, coverageScore: 0.4, title: 'A uses', type: 'article', difficulty: 'beginner', durationMin: 20 },
    ],
  },
  {
    slug: 'b', title: 'B', membership: ConceptMembership.spine, prerequisiteSlugs: ['a'],
    candidates: [
      { resourceId: 'r-b1', role: ConceptResourceRole.teaches, coverageScore: 0.8, title: 'B teach', type: 'video', difficulty: 'beginner', durationMin: 40 },
    ],
  },
  {
    slug: 'f', title: 'F', membership: ConceptMembership.frontier, prerequisiteSlugs: ['b'],
    candidates: [
      { resourceId: 'r-f1', role: ConceptResourceRole.teaches, coverageScore: 0.7, title: 'F teach', type: 'article', difficulty: 'advanced', durationMin: 25 },
    ],
  },
];
const edges: OrderEdge[] = [
  { fromSlug: 'a', toSlug: 'b' },
  { fromSlug: 'b', toSlug: 'f' },
];

function comp(over: Partial<ComposerResult>): ComposerResult {
  return {
    prune: [],
    omitForIntent: [],
    intent: TrackIntent.learn,
    lessons: [],
    trackTitle: 'T', trackSummary: 'S',
    resourceSufficiency: { enough: true, underResourced: [] },
    ...over,
  };
}
const L = (
  conceptSlugs: string[],
  primaryResourceId: string | null,
  over: Partial<ComposerResult['lessons'][number]> = {},
) => ({
  conceptSlugs, primaryResourceId, title: conceptSlugs.join('+'), summary: 's',
  isFrontier: false, masteryRelevant: false,
  // New graded fields (2.5e-7 composer output); validateComposition still keys off
  // primaryResourceId, so these defaults just satisfy the ComposedLesson type.
  timeWeight: 'normal' as const,
  mandatoryResourceIds: primaryResourceId ? [primaryResourceId] : [],
  optionalResourceIds: [],
  ...over,
});

describe('validateComposition — valid composition', () => {
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true, masteryRelevant: true })] }),
    concepts, edges,
  });
  const order = out.lessons.map((l) => l.conceptSlugs.join());

  it('three lessons in DAG order a,b,f', () => {
    expect(out.lessons.length).toBe(3);
    expect(order.join(',')).toBe('a,b,f');
  });
  it('mandatory cores honored', () => {
    expect(out.lessons[0].mandatoryResourceIds[0]).toBe('r-a1');
    expect(out.lessons[1].mandatoryResourceIds[0]).toBe('r-b1');
  });
  it('optional pool for a = [r-a2]', () => expect(out.lessons[0].optionalResourceIds).toEqual(['r-a2']));
  it('timeWeight carried (a=normal)', () => expect(out.lessons[0].timeWeight).toBe('normal'));
  it('frontier flagged on f', () => {
    expect(out.lessons[2].isFrontier).toBe(true);
    expect(out.lessons[2].masteryRelevant).toBe(true);
  });
  it('no warnings', () => expect(out.warnings.length).toBe(0));
});

describe('validateComposition — invalid primary handle falls back', () => {
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'bogus'), L(['b'], 'r-b1'), L(['f'], 'r-f1')] }),
    concepts, edges,
  });
  it('fallback to top teaches r-a1', () =>
    expect(out.lessons.find((l) => l.conceptSlugs[0] === 'a')!.mandatoryResourceIds[0]).toBe('r-a1'));
  it('warned about fallback', () => expect(out.warnings.some((w) => w.includes('fell back'))).toBe(true));
});

describe('validateComposition — omitted non-prereq frontier stays excluded (mastery depth)', () => {
  // f is a frontier LEAF (b→f: nothing depends on f). Composer omits it → it is NOT
  // pulled back by closure, so the learner's mastery depth is honored.
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1')] }), // f omitted
    concepts, edges,
  });
  it('f excluded (not synthesized)', () => expect(out.lessons.some((l) => l.conceptSlugs.includes('f'))).toBe(false));
  it('exactly the two kept lessons', () => expect(out.lessons.length).toBe(2));
  it('no closure warning for f', () => expect(out.warnings.some((w) => w.includes("'f'"))).toBe(false));
});

describe('validateComposition — frontier prerequisite of spine is force-included (closure)', () => {
  // f0 (frontier) → a (spine) → b (spine): a manual map edit can leave a spine concept
  // depending on a frontier one. The composer omits f0, but a depends on it, so closure
  // must pull f0 back in — never orphan the spine concept.
  const fgConcepts = [
    { slug: 'f0', title: 'F0', membership: ConceptMembership.frontier, prerequisiteSlugs: [],
      candidates: [{ resourceId: 'r-f0', role: ConceptResourceRole.teaches, coverageScore: 0.6, title: 'F0 teach', type: 'article', difficulty: 'beginner', durationMin: 15 }] },
    { slug: 'a', title: 'A', membership: ConceptMembership.spine, prerequisiteSlugs: ['f0'],
      candidates: [{ resourceId: 'r-a1', role: ConceptResourceRole.teaches, coverageScore: 0.9, title: 'A teach', type: 'article', difficulty: 'beginner', durationMin: 30 }] },
    { slug: 'b', title: 'B', membership: ConceptMembership.spine, prerequisiteSlugs: ['a'],
      candidates: [{ resourceId: 'r-b1', role: ConceptResourceRole.teaches, coverageScore: 0.8, title: 'B teach', type: 'video', difficulty: 'beginner', durationMin: 40 }] },
  ];
  const fgEdges: OrderEdge[] = [
    { fromSlug: 'f0', toSlug: 'a' },
    { fromSlug: 'a', toSlug: 'b' },
  ];
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1')] }), // f0 omitted
    concepts: fgConcepts, edges: fgEdges,
  });

  it('f0 re-included as a spine prerequisite', () => expect(out.lessons.some((l) => l.conceptSlugs.includes('f0'))).toBe(true));
  it('f0 ordered before its dependent a', () =>
    expect(out.lessons.findIndex((l) => l.conceptSlugs.includes('f0'))).toBeLessThan(
      out.lessons.findIndex((l) => l.conceptSlugs.includes('a')),
    ));
  it('warned about closure re-inclusion', () =>
    expect(out.warnings.some((w) => w.includes("frontier concept 'f0' re-included"))).toBe(true));
});

describe('validateComposition — spine concept can be pruned when known (2.5e-5)', () => {
  // The learner already knows the middle spine concept b. Pruning it is now legal:
  // closure no longer forces it back, so the Track skips it.
  const out = validateComposition({
    composition: comp({ prune: ['b'], lessons: [L(['a'], 'r-a1'), L(['f'], 'r-f1', { isFrontier: true })] }),
    concepts, edges,
  });
  it('b pruned (absent)', () => expect(out.lessons.some((l) => l.conceptSlugs.includes('b'))).toBe(false));
  it('a and f remain', () => expect(out.lessons.length).toBe(2));
  it('no "refused to prune" warning', () => expect(out.warnings.some((w) => w.includes('refused to prune'))).toBe(false));
});

describe('validateComposition — pruned spine prerequisite is not re-added via closure (2.5e-5)', () => {
  // a (spine) → b (spine) → f: a is a foundational prerequisite of b. The learner knows
  // a, so it is pruned. The dependent b stays, and closure must NOT pull a back in.
  const out = validateComposition({
    composition: comp({ prune: ['a'], lessons: [L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true })] }),
    concepts, edges,
  });
  it('a stays pruned (not re-added)', () => expect(out.lessons.some((l) => l.conceptSlugs.includes('a'))).toBe(false));
  it('dependent b stays', () => expect(out.lessons.some((l) => l.conceptSlugs.includes('b'))).toBe(true));
  it('two lessons remain (b, f)', () => expect(out.lessons.length).toBe(2));
});

describe('validateComposition — frontier concept can be pruned', () => {
  const out = validateComposition({
    composition: comp({ prune: ['f'], lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1')] }),
    concepts, edges,
  });
  it('f pruned (absent)', () => expect(out.lessons.some((l) => l.conceptSlugs.includes('f'))).toBe(false));
  it('two lessons remain', () => expect(out.lessons.length).toBe(2));
});

describe('validateComposition — omitForIntent drops a spine concept like prune (2.5e-8)', () => {
  // a (spine) → b (spine) → f. Intent (cram/review) omits foundational a without an
  // explicit prior-knowledge statement. Structurally identical to prune.
  const out = validateComposition({
    composition: comp({
      omitForIntent: [{ conceptSlug: 'a', reason: 'exam_prep: intro the cohort has' }],
      lessons: [L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true })],
    }),
    concepts, edges,
  });
  it('a omitted (absent), dependent b stays, two lessons remain', () => {
    expect(out.lessons.some((l) => l.conceptSlugs.includes('a'))).toBe(false);
    expect(out.lessons.some((l) => l.conceptSlugs.includes('b'))).toBe(true);
    expect(out.lessons.length).toBe(2);
  });
  it('omission surfaced in warnings', () =>
    expect(out.warnings.some((w) => w.includes('omitted') && w.includes("'a'") && w.includes('intent'))).toBe(true));
});

describe('validateComposition — composer order is overridden by the DAG', () => {
  it('reordered to a,b,f', () => {
    const out = validateComposition({
      composition: comp({ lessons: [L(['f'], 'r-f1'), L(['b'], 'r-b1'), L(['a'], 'r-a1')] }), // reversed
      concepts, edges,
    });
    expect(out.lessons.map((l) => l.conceptSlugs.join()).join(',')).toBe('a,b,f');
  });
});

describe('validateComposition — merged lesson pools + dedups alternates', () => {
  const out = validateComposition({
    composition: comp({ lessons: [L(['a', 'b'], 'r-a1'), L(['f'], 'r-f1')] }),
    concepts, edges,
  });
  const merged = out.lessons.find((l) => l.conceptSlugs.length === 2)!;

  it('merged lesson present with core = [r-a1]', () => {
    expect(merged).toBeTruthy();
    expect(merged.mandatoryResourceIds).toEqual(['r-a1']);
  });
  it('merged optional pool = b1,a2 (non-core, coverage-desc)', () =>
    expect(merged.optionalResourceIds).toEqual(['r-b1', 'r-a2']));
  it('merged lesson ordered before f', () => expect(out.lessons[0].conceptSlugs.length).toBe(2));
});

describe('validateComposition — cross-concept resource: dropped by default, kept under the agent flag (2.5e-8 block 2c)', () => {
  // Lesson for concept a is graded with r-b1 — a resource that belongs to concept b.
  const composition = comp({ lessons: [L(['a'], 'r-b1'), L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true })] });

  it('default: cross-concept id dropped, fell back to r-a1', () => {
    const off = validateComposition({ composition, concepts, edges });
    expect(off.lessons.find((l) => l.conceptSlugs[0] === 'a')!.mandatoryResourceIds[0]).toBe('r-a1');
  });
  it('flag on: cross-concept id r-b1 kept as primary', () => {
    const on = validateComposition({ composition, concepts, edges, crossConceptResources: true });
    expect(on.lessons.find((l) => l.conceptSlugs[0] === 'a')!.mandatoryResourceIds[0]).toBe('r-b1');
  });
  it('flag on: unknown id still rejected (falls back)', () => {
    const out = validateComposition({
      composition: comp({ lessons: [L(['a'], 'does-not-exist')] }),
      concepts, edges, crossConceptResources: true,
    });
    expect(out.lessons[0].mandatoryResourceIds[0]).toBe('r-a1');
  });
});

// The extracted pure helpers that BOTH validateComposition and the Block 2b agent
// tools depend on. Exercised directly so the contract is locked independent of the
// composer pipeline.
describe('composition-core — buildPrereqIndex / computeInclusion / order / assign', () => {
  const slugs = concepts.map((c) => c.slug);
  const prereqsOf = buildPrereqIndex(slugs, edges);

  it('prereq index reflects the DAG', () => {
    expect(prereqsOf.get('b')).toEqual(['a']);
    expect(prereqsOf.get('f')).toEqual(['b']);
    expect(prereqsOf.get('a')).toEqual([]);
  });
  it('inclusion(f) = {a,b,f} (transitive closure)', () => {
    const fromF = computeInclusion({ prereqsOf, excluded: new Set(), seeds: ['f'] });
    expect(fromF.size).toBe(3);
    expect(fromF.has('a')).toBe(true);
    expect(fromF.has('b')).toBe(true);
    expect(fromF.has('f')).toBe(true);
  });
  it('excluding a stops the walk: {b,f}, a not re-added', () => {
    const exclA = computeInclusion({ prereqsOf, excluded: new Set(['a']), seeds: ['b', 'f'] });
    expect(exclA.size).toBe(2);
    expect(exclA.has('b')).toBe(true);
    expect(exclA.has('f')).toBe(true);
    expect(exclA.has('a')).toBe(false);
  });
  it('order = a,b,f regardless of seed order', () =>
    expect(orderConceptSlugs(['f', 'a', 'b'], edges).join(',')).toBe('a,b,f'));

  it('assignConceptsToLessons honors a grouping and synthesizes the leftover', () => {
    const warns: string[] = [];
    const groups = assignConceptsToLessons({
      lessons: [{ conceptSlugs: ['a', 'b'], title: 'A+B', summary: 's', masteryRelevant: false, timeWeight: 'normal', mandatoryResourceIds: ['r-a1'], optionalResourceIds: [] }],
      included: new Set(['a', 'b', 'f']),
      concepts,
      warnings: warns,
    });
    expect(groups[0].conceptSlugs).toEqual(['a', 'b']);
    expect(groups.length).toBe(2);
    expect(groups[1].conceptSlugs).toEqual(['f']);
    expect(warns.some((w) => w.includes("'f'") && w.includes('synthesized'))).toBe(true);
  });
});
