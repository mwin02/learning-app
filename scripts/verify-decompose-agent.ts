// Verify (LIVE) for the decomposer-agent plan (Block 5): run the real tool-using
// Stage-1 decomposition (decompose-agent.ts) against the live library and print the
// result — proposals, tool-loop stats, and per-topic frontier requests — for manual
// inspection. Costs a handful of Flash calls (+ get_path_map DB reads).
//
//   npx tsx --env-file=.env.local scripts/verify-decompose-agent.ts ["<goal>"] [--plan]
//
// Default goal is a multi-topic one that should exercise get_path_map + frontier
// requests against library topics. --plan additionally runs the FULL planProgram pass
// (Stages 2/2.5/3 over a second live decomposition) to show frontier requests
// surviving the gate/reconcile/budget to the AllocatedProgramTopics the fan-out
// persists. Note: the Stage-2 gate upserts TopicAlias rows (idempotent), so --plan
// writes to the registry exactly as a real enqueue would; the agent-only default is
// read-only.

import { prisma } from '../src/lib/db';
import { decomposeProgramAgent } from '../src/lib/agents/program/decompose-agent';
import { planProgram, type ProgramPlanInput } from '../src/lib/agents/program/plan';

const DEFAULT_GOAL =
  'I want to build and train my own deep reinforcement learning agent for game-playing. ' +
  'I can code but my math is rusty.';

async function main() {
  const args = process.argv.slice(2);
  const runPlan = args.includes('--plan');
  const goal = args.find((a) => a !== '--plan') ?? DEFAULT_GOAL;

  const input: ProgramPlanInput = {
    goal,
    background: 'Comfortable in Python; last did math in high school.',
    totalHoursPerWeek: 8,
    totalWeeks: 12,
  };

  console.log(`\n--- live decompose-agent run ---`);
  console.log(`goal: ${input.goal}`);
  console.log(`background: ${input.background}`);
  console.log(`budget: ${input.totalHoursPerWeek} h/wk × ${input.totalWeeks} weeks`);

  const deco = await decomposeProgramAgent(input);
  console.log(`\ntitle: ${deco.title}`);
  console.log(`description: ${deco.description}`);
  console.log(`\n${deco.topics.length} proposed topic(s):`);
  for (const t of deco.topics) {
    console.log(`  [${t.orderHint}] ${t.topic}  (${t.priorityTier}, weight=${t.weight}) {${t.phaseLabel}}`);
    console.log(`      rationale: ${t.rationale}`);
    console.log(`      frontierConcepts: ${t.frontierConcepts.join(', ') || '(none)'}`);
  }
  const frontierTotal = deco.topics.reduce((n, t) => n + t.frontierConcepts.length, 0);
  console.log(`\nfrontier requests total: ${frontierTotal}`);

  if (runPlan) {
    console.log(`\n--- full planProgram pass (gate → reconcile → budget) ---`);
    const plan = await planProgram(input);
    console.log(`title: ${plan.title}`);
    console.log(`${plan.topics.length} allocated topic(s):`);
    for (const t of plan.topics) {
      console.log(
        `  ${t.orderInProgram}. ${t.key}  (${t.priorityTier}) ${t.hoursPerWeek} h/wk × ${t.timeframeWeeks} wks {${t.phaseLabel}}`,
      );
      console.log(`      frontierConcepts: ${t.frontierConcepts.join(', ') || '(none)'}`);
    }
    if (plan.droppedByGate.length)
      console.log(`droppedByGate: ${plan.droppedByGate.map((d) => `${d.topic} (${d.reason})`).join('; ')}`);
    if (plan.droppedByBudget.length)
      console.log(`droppedByBudget: ${plan.droppedByBudget.map((d) => `${d.key} (${d.reason})`).join('; ')}`);
  }

  await prisma.$disconnect();
}
main();
