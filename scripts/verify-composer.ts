// Throwaway verification for Phase 2.5e-2 (composer + re-validation).
//   npx tsx --env-file=.env.local scripts/verify-composer.ts            # pure fixtures only
//   npx tsx --env-file=.env.local scripts/verify-composer.ts machine-learning  # + live composer run
//
// Part 1 (always) asserts the deterministic invariants of validateComposition
// with no LLM. Part 2 (when a topic is given) runs the real composer against a
// seeded spine_ready map and prints the result for manual inspection.

import { ConceptMembership, ConceptResourceRole, Difficulty } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { validateComposition } from '../src/lib/agents/track/validate-composition';
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
    slug: 'a', title: 'A', membership: ConceptMembership.spine,
    candidates: [
      { resourceId: 'r-a1', role: ConceptResourceRole.teaches, coverageScore: 0.9, title: 'A teach', type: 'article', difficulty: 'beginner', durationMin: 30 },
      { resourceId: 'r-a2', role: ConceptResourceRole.uses, coverageScore: 0.4, title: 'A uses', type: 'article', difficulty: 'beginner', durationMin: 20 },
    ],
  },
  {
    slug: 'b', title: 'B', membership: ConceptMembership.spine,
    candidates: [
      { resourceId: 'r-b1', role: ConceptResourceRole.teaches, coverageScore: 0.8, title: 'B teach', type: 'video', difficulty: 'beginner', durationMin: 40 },
    ],
  },
  {
    slug: 'f', title: 'F', membership: ConceptMembership.frontier,
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
    lessons: [],
    trackTitle: 'T', trackSummary: 'S',
    resourceSufficiency: { enough: true, underResourced: [] },
    ...over,
  };
}
const L = (conceptSlugs: string[], primaryResourceId: string | null, over: Partial<ComposerResult['lessons'][number]> = {}) => ({
  conceptSlugs, primaryResourceId, title: conceptSlugs.join('+'), summary: 's',
  isFrontier: false, masteryRelevant: false, ...over,
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
  check('primaries honored', out.lessons[0].primaryResourceId === 'r-a1' && out.lessons[1].primaryResourceId === 'r-b1');
  check('alternates for a = [r-a2]', JSON.stringify(out.lessons[0].alternateResourceIds) === '["r-a2"]', out.lessons[0].alternateResourceIds);
  check('estMinutes from primary (a=30)', out.lessons[0].estMinutes === 30);
  check('frontier flagged on f', out.lessons[2].isFrontier === true && out.lessons[2].masteryRelevant === true);
  check('no warnings', out.warnings.length === 0, out.warnings);
}

console.log('validateComposition — invalid primary handle falls back');
{
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'bogus'), L(['b'], 'r-b1'), L(['f'], 'r-f1')] }),
    concepts, edges,
  });
  check('fallback to top teaches r-a1', out.lessons.find((l) => l.conceptSlugs[0] === 'a')!.primaryResourceId === 'r-a1');
  check('warned about fallback', out.warnings.some((w) => w.includes('fell back')), out.warnings);
}

console.log('validateComposition — omitted concept is synthesized');
{
  const out = validateComposition({
    composition: comp({ lessons: [L(['a'], 'r-a1'), L(['b'], 'r-b1')] }), // f omitted
    concepts, edges,
  });
  check('f synthesized', out.lessons.some((l) => l.conceptSlugs[0] === 'f'));
  check('warned about omission', out.warnings.some((w) => w.includes("omitted concept 'f'")), out.warnings);
  check('synthesized f got its only candidate', out.lessons.find((l) => l.conceptSlugs[0] === 'f')!.primaryResourceId === 'r-f1');
}

console.log('validateComposition — spine concept cannot be pruned');
{
  const out = validateComposition({
    composition: comp({ prune: ['b'], lessons: [L(['a'], 'r-a1'), L(['f'], 'r-f1')] }),
    concepts, edges,
  });
  check('b survives the prune', out.lessons.some((l) => l.conceptSlugs.includes('b')));
  check('warned about refused prune', out.warnings.some((w) => w.includes("refused to prune spine concept 'b'")), out.warnings);
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
  check('merged alternates = a2,b1 (non-primary, coverage-desc)', JSON.stringify(merged.alternateResourceIds) === '["r-b1","r-a2"]', merged.alternateResourceIds);
  check('merged lesson ordered before f', out.lessons[0].conceptSlugs.length === 2, out.lessons.map((l) => l.conceptSlugs));
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
    priorKnowledge: 'I am comfortable with basic programming and high-school algebra.',
    targetMastery: Difficulty.intermediate,
    budgetMinutes: 6 * 5 * 60,
  });
  const { lessons, warnings } = validateComposition({ composition, concepts: inputConcepts, edges: liveEdges });

  console.log(`\npruned: ${composition.prune.join(', ') || '(none)'}`);
  console.log(`track: ${composition.trackTitle}\n  ${composition.trackSummary}`);
  console.log(`sufficiency: enough=${composition.resourceSufficiency.enough} underResourced=${composition.resourceSufficiency.underResourced.map((u) => u.conceptSlug).join(',') || '(none)'}`);
  if (warnings.length) console.log(`warnings:\n  - ${warnings.join('\n  - ')}`);
  console.log('\nlessons (DAG order):');
  lessons.forEach((l, i) => {
    console.log(`  ${i + 1}. [${l.conceptSlugs.join('+')}]${l.isFrontier ? ' (frontier)' : ''} — ${l.title}`);
    console.log(`      primary=${l.primaryResourceId} alts=${l.alternateResourceIds.length} est=${l.estMinutes}m`);
  });
}

async function main() {
  const topic = process.argv[2];
  if (topic) await liveRun(topic);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
