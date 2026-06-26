// Throwaway verification for Phase 2.5e-2 (composer + re-validation).
//   npx tsx --env-file=.env.local scripts/verify-composer.ts            # pure fixtures only
//   npx tsx --env-file=.env.local scripts/verify-composer.ts machine-learning  # + live composer run
//
// Part 1 (always) asserts the deterministic invariants of validateComposition
// with no LLM. Part 2 (when a topic is given) runs the real composer against a
// seeded spine_ready map and prints the result for manual inspection.

import { ConceptMembership, ConceptResourceRole, Difficulty, TrackIntent } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { validateComposition } from '../src/lib/agents/track/validate-composition';
import {
  buildPrereqIndex,
  computeInclusion,
  assignConceptsToLessons,
  orderConceptSlugs,
} from '../src/lib/agents/track/composition-core';
import { composeTrack, type ComposerInputConcept, type ComposerResult } from '../src/lib/agents/track/composer';
import type { OrderEdge } from '../src/lib/agents/map/order';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, detail ?? ''); }
}

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
const L = (conceptSlugs: string[], primaryResourceId: string | null, over: Partial<ComposerResult['lessons'][number]> = {}) => ({
  conceptSlugs, primaryResourceId, title: conceptSlugs.join('+'), summary: 's',
  isFrontier: false, masteryRelevant: false,
  // New graded fields (2.5e-7 composer output); validateComposition still keys off
  // primaryResourceId, so these defaults just satisfy the ComposedLesson type.
  timeWeight: 'normal' as const,
  mandatoryResourceIds: primaryResourceId ? [primaryResourceId] : [],
  optionalResourceIds: [],
  ...over,
});

console.log('validateComposition — valid composition');
{
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true, masteryRelevant: true })] }),
    concepts, edges,
  });
  const order = out.lessons.map((l) => l.conceptSlugs.join());
  check('three lessons', out.lessons.length === 3, order);
  check('DAG order a,b,f', order.join(',') === 'a,b,f', order);
  check('mandatory cores honored', out.lessons[0].mandatoryResourceIds[0] === 'r-a1' && out.lessons[1].mandatoryResourceIds[0] === 'r-b1');
  check('optional pool for a = [r-a2]', JSON.stringify(out.lessons[0].optionalResourceIds) === '["r-a2"]', out.lessons[0].optionalResourceIds);
  check('timeWeight carried (a=normal)', out.lessons[0].timeWeight === 'normal', out.lessons[0].timeWeight);
  check('frontier flagged on f', out.lessons[2].isFrontier === true && out.lessons[2].masteryRelevant === true);
  check('no warnings', out.warnings.length === 0, out.warnings);
}

console.log('validateComposition — invalid primary handle falls back');
{
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'bogus'), L(['b'], 'r-b1'), L(['f'], 'r-f1')] }),
    concepts, edges,
  });
  check('fallback to top teaches r-a1', out.lessons.find((l) => l.conceptSlugs[0] === 'a')!.mandatoryResourceIds[0] === 'r-a1');
  check('warned about fallback', out.warnings.some((w) => w.includes('fell back')), out.warnings);
}

console.log('validateComposition — omitted non-prereq frontier stays excluded (mastery depth)');
{
  // f is a frontier LEAF (b→f: nothing depends on f). Composer omits it → it is
  // NOT pulled back by closure, so the learner's mastery depth is honored.
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1')] }), // f omitted
    concepts, edges,
  });
  check('f excluded (not synthesized)', !out.lessons.some((l) => l.conceptSlugs.includes('f')), out.lessons.map((l) => l.conceptSlugs));
  check('exactly the two kept lessons', out.lessons.length === 2);
  check('no closure warning for f', !out.warnings.some((w) => w.includes("'f'")), out.warnings);
}

console.log('validateComposition — frontier prerequisite of spine is force-included (closure)');
{
  // f0 (frontier) → a (spine) → b (spine): a manual map edit can leave a spine
  // concept depending on a frontier one. The composer omits f0, but a depends on
  // it, so closure must pull f0 back in — never orphan the spine concept.
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
  check('f0 re-included as a spine prerequisite', out.lessons.some((l) => l.conceptSlugs.includes('f0')), out.lessons.map((l) => l.conceptSlugs));
  check('f0 ordered before its dependent a', out.lessons.findIndex((l) => l.conceptSlugs.includes('f0')) < out.lessons.findIndex((l) => l.conceptSlugs.includes('a')));
  check('warned about closure re-inclusion', out.warnings.some((w) => w.includes("frontier concept 'f0' re-included")), out.warnings);
}

console.log('validateComposition — spine concept can be pruned when known (2.5e-5)');
{
  // The learner already knows the middle spine concept b. Pruning it is now legal:
  // closure no longer forces it back, so the Track skips it.
  const out = validateComposition({
    composition: comp({ prune: ['b'], lessons: [L(['a'], 'r-a1'), L(['f'], 'r-f1', { isFrontier: true })] }),
    concepts, edges,
  });
  check('b pruned (absent)', !out.lessons.some((l) => l.conceptSlugs.includes('b')), out.lessons.map((l) => l.conceptSlugs));
  check('a and f remain', out.lessons.length === 2, out.lessons.map((l) => l.conceptSlugs));
  check('no "refused to prune" warning', !out.warnings.some((w) => w.includes('refused to prune')), out.warnings);
}

console.log('validateComposition — pruned spine prerequisite is not re-added via closure (2.5e-5)');
{
  // a (spine) → b (spine) → f: a is a foundational prerequisite of b. The learner
  // knows a, so it is pruned. The dependent b stays, and closure must NOT pull a
  // back in — the learner's knowledge satisfies b's prerequisite.
  const out = validateComposition({
    composition: comp({ prune: ['a'], lessons: [L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true })] }),
    concepts, edges,
  });
  check('a stays pruned (not re-added)', !out.lessons.some((l) => l.conceptSlugs.includes('a')), out.lessons.map((l) => l.conceptSlugs));
  check('dependent b stays', out.lessons.some((l) => l.conceptSlugs.includes('b')), out.lessons.map((l) => l.conceptSlugs));
  check('two lessons remain (b, f)', out.lessons.length === 2, out.lessons.map((l) => l.conceptSlugs));
}

console.log('validateComposition — frontier concept can be pruned');
{
  const out = validateComposition({
    composition: comp({ prune: ['f'], lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1')] }),
    concepts, edges,
  });
  check('f pruned (absent)', !out.lessons.some((l) => l.conceptSlugs.includes('f')), out.lessons.map((l) => l.conceptSlugs));
  check('two lessons remain', out.lessons.length === 2);
}

console.log('validateComposition — omitForIntent drops a spine concept like prune (2.5e-8)');
{
  // a (spine) → b (spine) → f. Intent (cram/review) omits foundational a without an
  // explicit prior-knowledge statement. Structurally identical to prune: a is
  // excluded, dependent b stays, and closure must NOT pull a back in.
  const out = validateComposition({
    composition: comp({
      omitForIntent: [{ conceptSlug: 'a', reason: 'exam_prep: intro the cohort has' }],
      lessons: [L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true })],
    }),
    concepts, edges,
  });
  check('a omitted (absent)', !out.lessons.some((l) => l.conceptSlugs.includes('a')), out.lessons.map((l) => l.conceptSlugs));
  check('dependent b stays', out.lessons.some((l) => l.conceptSlugs.includes('b')), out.lessons.map((l) => l.conceptSlugs));
  check('two lessons remain (b, f)', out.lessons.length === 2, out.lessons.map((l) => l.conceptSlugs));
  check('omission surfaced in warnings', out.warnings.some((w) => w.includes("omitted") && w.includes("'a'") && w.includes('intent')), out.warnings);
}

console.log('validateComposition — composer order is overridden by the DAG');
{
  const out = validateComposition({
    composition: comp({ lessons: [L(['f'], 'r-f1'), L(['b'], 'r-b1'), L(['a'], 'r-a1')] }), // reversed
    concepts, edges,
  });
  check('reordered to a,b,f', out.lessons.map((l) => l.conceptSlugs.join()).join(',') === 'a,b,f', out.lessons.map((l) => l.conceptSlugs));
}

console.log('validateComposition — merged lesson pools + dedups alternates');
{
  const out = validateComposition({
    composition: comp({ lessons: [L(['a', 'b'], 'r-a1'), L(['f'], 'r-f1')] }),
    concepts, edges,
  });
  const merged = out.lessons.find((l) => l.conceptSlugs.length === 2)!;
  check('merged lesson present', !!merged);
  check('merged core = [r-a1]', JSON.stringify(merged.mandatoryResourceIds) === '["r-a1"]', merged.mandatoryResourceIds);
  check('merged optional pool = b1,a2 (non-core, coverage-desc)', JSON.stringify(merged.optionalResourceIds) === '["r-b1","r-a2"]', merged.optionalResourceIds);
  check('merged lesson ordered before f', out.lessons[0].conceptSlugs.length === 2, out.lessons.map((l) => l.conceptSlugs));
}

console.log('validateComposition — cross-concept resource: dropped by default, kept under the agent flag (2.5e-8 block 2c)');
{
  // Lesson for concept a is graded with r-b1 — a resource that belongs to concept b.
  const composition = comp({ lessons: [L(['a'], 'r-b1'), L(['b'], 'r-b1'), L(['f'], 'r-f1', { isFrontier: true })] });

  // Default (single-pass): a's lesson can't keep b's resource → falls back to a's top teaches.
  const off = validateComposition({ composition, concepts, edges });
  const aOff = off.lessons.find((l) => l.conceptSlugs[0] === 'a')!;
  check('default: cross-concept id dropped, fell back to r-a1', aOff.mandatoryResourceIds[0] === 'r-a1', aOff.mandatoryResourceIds);

  // Agent flag on: a's lesson keeps b's resource as its primary (re-purposed across concepts).
  const on = validateComposition({ composition, concepts, edges, crossConceptResources: true });
  const aOn = on.lessons.find((l) => l.conceptSlugs[0] === 'a')!;
  check('flag on: cross-concept id r-b1 kept as primary', aOn.mandatoryResourceIds[0] === 'r-b1', aOn.mandatoryResourceIds);
  // b's own lesson still gets r-b1 too; cross-lesson dedup is cleanupLessons' job, not validate's.
  check('flag on: unknown id still rejected', validateComposition({ composition: comp({ lessons: [L(['a'], 'does-not-exist')] }), concepts, edges, crossConceptResources: true }).lessons[0].mandatoryResourceIds[0] === 'r-a1', 'fallback expected');
}

// --- composition-core primitives (Block 2a): direct unit coverage --------
// The extracted pure helpers that BOTH validateComposition and the Block 2b agent
// tools depend on. Exercised directly so the contract is locked independent of the
// composer pipeline.
console.log('composition-core — buildPrereqIndex / computeInclusion / order / assign');
{
  const slugs = concepts.map((c) => c.slug);
  const prereqsOf = buildPrereqIndex(slugs, edges);
  check('prereq index: b←a', JSON.stringify(prereqsOf.get('b')) === '["a"]', prereqsOf.get('b'));
  check('prereq index: f←b', JSON.stringify(prereqsOf.get('f')) === '["b"]', prereqsOf.get('f'));
  check('prereq index: a has no prereqs', JSON.stringify(prereqsOf.get('a')) === '[]', prereqsOf.get('a'));

  // Closure from seed f pulls in its transitive prereqs b, a.
  const fromF = computeInclusion({ prereqsOf, excluded: new Set(), seeds: ['f'] });
  check('inclusion(f) = {a,b,f}', fromF.size === 3 && fromF.has('a') && fromF.has('b') && fromF.has('f'), [...fromF]);

  // Excluding a (e.g. omitted/known) stops the walk: dependent b stays, a is not re-added.
  const exclA = computeInclusion({ prereqsOf, excluded: new Set(['a']), seeds: ['b', 'f'] });
  check('inclusion excl a = {b,f}', exclA.size === 2 && exclA.has('b') && exclA.has('f') && !exclA.has('a'), [...exclA]);

  // Ordering respects the DAG regardless of seed/iteration order.
  check('order = a,b,f', orderConceptSlugs(['f', 'a', 'b'], edges).join(',') === 'a,b,f', orderConceptSlugs(['f', 'a', 'b'], edges));

  // assignConceptsToLessons: honors a grouping and synthesizes the leftover.
  const warns: string[] = [];
  const groups = assignConceptsToLessons({
    lessons: [{ conceptSlugs: ['a', 'b'], title: 'A+B', summary: 's', masteryRelevant: false, timeWeight: 'normal', mandatoryResourceIds: ['r-a1'], optionalResourceIds: [] }],
    included: new Set(['a', 'b', 'f']),
    concepts,
    warnings: warns,
  });
  check('assign: merged group [a,b] kept', JSON.stringify(groups[0].conceptSlugs) === '["a","b"]', groups[0].conceptSlugs);
  check('assign: f synthesized as singleton', groups.length === 2 && JSON.stringify(groups[1].conceptSlugs) === '["f"]', groups.map((g) => g.conceptSlugs));
  check('assign: synthesis warned', warns.some((w) => w.includes("'f'") && w.includes('synthesized')), warns);
}

console.log(failures === 0 ? '\nFIXTURES: ALL PASS' : `\nFIXTURES: ${failures} FAILED`);

// --- Part 2: optional live run ------------------------------------------
async function liveRun(topic: string) {
  console.log(`\n--- live composer run: topic='${topic}' ---`);
  const path = await prisma.path.findUnique({
    where: { topic },
    select: {
      id: true, status: true,
      concepts: {
        select: {
          slug: true, title: true, membership: true,
          prereqsIn: { select: { from: { select: { slug: true } } } },
          resources: {
            select: {
              role: true, coverageScore: true,
              resource: { select: { id: true, title: true, type: true, difficulty: true, durationMin: true } },
            },
            orderBy: { coverageScore: 'desc' },
          },
        },
      },
    },
  });
  if (!path) { console.error(`no Path for topic '${topic}'`); return; }
  console.log(`path ${path.id} status=${path.status}, ${path.concepts.length} concepts`);

  const inputConcepts: ComposerInputConcept[] = path.concepts.map((c) => ({
    slug: c.slug, title: c.title, membership: c.membership,
    prerequisiteSlugs: c.prereqsIn.map((e) => e.from.slug),
    candidates: c.resources.map((r) => ({
      resourceId: r.resource.id, role: r.role, coverageScore: r.coverageScore,
      title: r.resource.title, type: r.resource.type,
      difficulty: r.resource.difficulty, durationMin: r.resource.durationMin,
    })),
  }));
  const liveEdges: OrderEdge[] = path.concepts.flatMap((c) =>
    c.prereqsIn.map((e) => ({ fromSlug: e.from.slug, toSlug: c.slug })),
  );

  const composition = await composeTrack({
    topic,
    concepts: inputConcepts,
    goal: 'I studied this years ago and just want to refresh the advanced topics before an exam.',
    priorKnowledge: 'I am comfortable with basic programming and high-school algebra.',
    targetMastery: Difficulty.intermediate,
    budgetMinutes: 6 * 5 * 60,
  });
  const { lessons, warnings } = validateComposition({ composition, concepts: inputConcepts, edges: liveEdges });

  console.log(`\ninferred intent: ${composition.intent}`);
  console.log(`pruned: ${composition.prune.join(', ') || '(none)'}`);
  console.log(`track: ${composition.trackTitle}\n  ${composition.trackSummary}`);
  console.log(`sufficiency: enough=${composition.resourceSufficiency.enough} underResourced=${composition.resourceSufficiency.underResourced.map((u) => u.conceptSlug).join(',') || '(none)'}`);
  if (warnings.length) console.log(`warnings:\n  - ${warnings.join('\n  - ')}`);
  console.log('\ncomposer grading (timeWeight + mandatory/optional counts):');
  composition.lessons.forEach((l) => {
    console.log(
      `  [${l.conceptSlugs.join('+')}] weight=${l.timeWeight} mandatory=${l.mandatoryResourceIds.length} optional=${l.optionalResourceIds.length}`,
    );
  });

  console.log('\nvalidated lessons (DAG order):');
  lessons.forEach((l, i) => {
    console.log(`  ${i + 1}. [${l.conceptSlugs.join('+')}]${l.isFrontier ? ' (frontier)' : ''} — ${l.title}`);
    console.log(`      weight=${l.timeWeight} mandatory=${l.mandatoryResourceIds.length} optional=${l.optionalResourceIds.length}`);
  });
}

async function main() {
  const topic = process.argv[2];
  if (topic) await liveRun(topic);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
