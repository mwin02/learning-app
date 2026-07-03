// Verify (LIVE half) for Phase 2.5e-2: run the real composer against a seeded
// spine_ready map and print the result for manual inspection. Costs one Pro compose.
//   npx tsx --env-file=.env.local scripts/verify-composer.ts <topic>
//
// The deterministic Part 1 (validateComposition + composition-core invariants) migrated
// to src/lib/agents/track/validate-composition.test.ts (R2).

import { Difficulty } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { validateComposition } from '../src/lib/agents/track/validate-composition';
import { composeTrack, type ComposerInputConcept } from '../src/lib/agents/track/composer';
import { depthTier } from '../src/lib/agents/track/allocate';
import type { OrderEdge } from '../src/lib/agents/map/order';

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
    depthTier: depthTier(6 * 5 * 60, inputConcepts.length),
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
  if (!topic) {
    console.error('usage: verify-composer.ts <topic>   (needs a seeded spine_ready Path)');
    process.exit(1);
  }
  await liveRun(topic);
  await prisma.$disconnect();
}
main();
