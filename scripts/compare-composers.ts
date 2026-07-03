// Phase 2.5e-8 (block 2d): composer parity / diff harness — the cutover gate.
//
// Builds the SAME learner inputs through BOTH composers (single-pass composer.ts and
// the tool-using composer-agent.ts), runs each through validateComposition, and prints
// the resulting lesson concept-sets side by side. No DB writes, no freeze, no thicken —
// it stops at the validated composition, so it's fast and repeatable. Use it to eyeball
// "do different intents produce different courses, and how does the agent differ from
// the single pass" before flipping TRACK_COMPOSER_MODE to 'agent'.
//
//   npx tsx --env-file=.env.local scripts/compare-composers.ts <pathId>
//   npx tsx --env-file=.env.local scripts/compare-composers.ts <pathId> --agent-only
//   npx tsx --env-file=.env.local scripts/compare-composers.ts <pathId> --runs 3   # variance
//
// Default inputs are the four calculus intents we keep regression-testing; edit SCENARIOS
// for another topic. The harness is composer-only, so it works on any spine_ready Path.

import { Difficulty } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { loadComposerMap } from '../src/lib/agents/track/build-track';
import { composeTrack } from '../src/lib/agents/track/composer';
import { composeTrackAgent } from '../src/lib/agents/track/composer-agent';
import { validateComposition } from '../src/lib/agents/track/validate-composition';
import { budgetMinutesFor } from '../src/lib/agents/track/plan';
import { depthTier } from '../src/lib/agents/track/allocate';

type Scenario = {
  label: string;
  goal: string;
  priorKnowledge: string | null;
  targetMastery: Difficulty;
  timeframeWeeks: number;
  hoursPerWeek: number;
};

const SCENARIOS: Scenario[] = [
  { label: 'exam cram', goal: 'Cram for my calculus exam next week', priorKnowledge: 'Already covered most topics', targetMastery: Difficulty.advanced, timeframeWeeks: 1, hoursPerWeek: 4 },
  { label: 'beginner learn', goal: 'I want to learn calculus', priorKnowledge: 'Basic math knowledge, algebra and geometry', targetMastery: Difficulty.beginner, timeframeWeeks: 3, hoursPerWeek: 5 },
  { label: 'review for stats', goal: 'refresh calculus before a stats course', priorKnowledge: null, targetMastery: Difficulty.beginner, timeframeWeeks: 4, hoursPerWeek: 5 },
  { label: 'grad refresh', goal: "Refresh Calculus before I start my Master's Program", priorKnowledge: 'Studied Calculus as an undergraduate', targetMastery: Difficulty.intermediate, timeframeWeeks: 3, hoursPerWeek: 3 },
];

type Built = { lessonConcepts: string[][]; pruned: number; omitted: number; intent: string };

async function buildOnce(
  mode: 'single' | 'agent',
  topic: string,
  loaded: Awaited<ReturnType<typeof loadComposerMap>>,
  s: Scenario,
): Promise<Built> {
  const budgetMinutes = budgetMinutesFor(s.timeframeWeeks, s.hoursPerWeek);
  const common = {
    topic,
    concepts: loaded.concepts,
    priorKnowledge: s.priorKnowledge,
    goal: s.goal,
    targetMastery: s.targetMastery,
    budgetMinutes,
    depthTier: depthTier(budgetMinutes, loaded.concepts.length),
  };
  const composition =
    mode === 'agent'
      ? await composeTrackAgent({ ...common, edges: loaded.edges })
      : await composeTrack(common);
  const { lessons } = validateComposition({
    composition,
    concepts: loaded.concepts,
    edges: loaded.edges,
    crossConceptResources: mode === 'agent',
  });
  return {
    lessonConcepts: lessons.map((l) => l.conceptSlugs),
    pruned: composition.prune.length,
    omitted: composition.omitForIntent.length,
    intent: composition.intent,
  };
}

function fmt(b: Built): string {
  const lines = b.lessonConcepts.map((cs, i) => `      ${i + 1}. ${cs.join(' + ')}`);
  return `    intent=${b.intent} lessons=${b.lessonConcepts.length} pruned=${b.pruned} omittedForIntent=${b.omitted}\n${lines.join('\n')}`;
}

async function main() {
  const pathId = process.argv[2];
  if (!pathId) {
    console.error('usage: tsx --env-file=.env.local scripts/compare-composers.ts <pathId> [--agent-only] [--runs N]');
    process.exit(1);
  }
  const agentOnly = process.argv.includes('--agent-only');
  const runsIdx = process.argv.indexOf('--runs');
  const runs = runsIdx >= 0 ? Math.max(1, Number(process.argv[runsIdx + 1])) : 1;

  const path = await prisma.path.findUnique({ where: { id: pathId }, select: { topic: true, status: true } });
  if (!path) throw new Error(`No Path '${pathId}'.`);
  console.log(`Path '${pathId}' — topic='${path.topic}' status=${path.status}\n`);
  const loaded = await loadComposerMap(pathId);
  console.log(`Loaded ${loaded.concepts.length} concepts, ${loaded.edges.length} edges.\n`);

  for (const s of SCENARIOS) {
    console.log(`━━━ ${s.label} — "${s.goal}" (mastery=${s.targetMastery}, ${s.timeframeWeeks}w×${s.hoursPerWeek}h)`);
    for (let run = 0; run < runs; run++) {
      const tag = runs > 1 ? ` [run ${run + 1}/${runs}]` : '';
      if (!agentOnly) {
        const single = await buildOnce('single', path.topic, loaded, s);
        console.log(`  SINGLE${tag}:\n${fmt(single)}`);
      }
      const agent = await buildOnce('agent', path.topic, loaded, s);
      console.log(`  AGENT${tag}:\n${fmt(agent)}`);
    }
    console.log('');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
