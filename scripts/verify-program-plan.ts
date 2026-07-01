// Fixture verification for Phase 2.75b (the program plan pass).
//   npx tsx --env-file=.env.local scripts/verify-program-plan.ts
//
// Pure fixtures + stubbed seams — no LLM, no DB. Asserts:
//   - allocateProgramBudget: floor-respecting largest-remainder split, exact sum,
//     maxTopics cap + budget-floor drops (nice_to_have first), dense ordering.
//   - planProgram wiring: gate drops out-of-domain, canonical-slug dedup, plan
//     surfaces both drop channels.

import { PriorityTier } from '@prisma/client';
import { allocateProgramBudget, type ProgramTopicInput } from '../src/lib/agents/program/budget';
import { planProgram, type ProposedTopic } from '../src/lib/agents/program/plan';
import type { TopicGateResult } from '../src/lib/agents/topic-gate';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

const T = (key: string, over: Partial<ProgramTopicInput> = {}): ProgramTopicInput => ({
  key,
  weight: 1,
  priorityTier: PriorityTier.core,
  phaseLabel: 'Phase 1',
  orderHint: 1,
  rationale: `why ${key}`,
  ...over,
});
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

console.log('allocateProgramBudget — split sums to budget, floor respected');
{
  const r = allocateProgramBudget(
    [T('a', { weight: 3, orderHint: 1 }), T('b', { weight: 1, orderHint: 2 })],
    { totalHoursPerWeek: 10, totalWeeks: 12 },
  );
  check('both kept', r.topics.length === 2 && r.dropped.length === 0);
  check('hours sum to totalHoursPerWeek', sum(r.topics.map((t) => t.hoursPerWeek)) === 10, r.topics);
  check('every topic ≥ floor 1', r.topics.every((t) => t.hoursPerWeek >= 1));
  // remainder 10-2=8 split 3:1 → 6/2, +floor → 7/3
  check('weighted split 7/3', JSON.stringify(r.topics.map((t) => t.hoursPerWeek)) === '[7,3]', r.topics);
  check('timeframeWeeks = totalWeeks', r.topics.every((t) => t.timeframeWeeks === 12));
  check('dense order 1..M by orderHint', JSON.stringify(r.topics.map((t) => t.orderInProgram)) === '[1,2]');
}

console.log('allocateProgramBudget — dense renumber follows orderHint, not input order');
{
  const r = allocateProgramBudget(
    [T('late', { orderHint: 9 }), T('early', { orderHint: 1 })],
    { totalHoursPerWeek: 6, totalWeeks: 8 },
  );
  check('early first', r.topics[0].key === 'early' && r.topics[0].orderInProgram === 1);
  check('late second', r.topics[1].key === 'late' && r.topics[1].orderInProgram === 2);
}

console.log('allocateProgramBudget — maxTopics cap drops nice_to_have first');
{
  const topics = [
    T('a', { weight: 5, priorityTier: PriorityTier.core }),
    T('b', { weight: 4, priorityTier: PriorityTier.core }),
    T('c', { weight: 3, priorityTier: PriorityTier.nice_to_have }),
    T('d', { weight: 2, priorityTier: PriorityTier.nice_to_have }),
  ];
  const r = allocateProgramBudget(topics, { totalHoursPerWeek: 20, totalWeeks: 10, maxTopics: 2 });
  check('capped to 2', r.topics.length === 2, r.topics.map((t) => t.key));
  check('kept the two core', r.topics.map((t) => t.key).sort().join() === 'a,b');
  check('dropped c,d as over_max_topics', r.dropped.length === 2 && r.dropped.every((d) => d.reason === 'over_max_topics'));
}

console.log('allocateProgramBudget — tight budget drops on floor (nice_to_have before core)');
{
  // floor=1, budget=2 → only 2 topics fit; 3 proposed → drop the 1 nice_to_have.
  const topics = [
    T('core1', { weight: 5, priorityTier: PriorityTier.core }),
    T('core2', { weight: 4, priorityTier: PriorityTier.core }),
    T('extra', { weight: 9, priorityTier: PriorityTier.nice_to_have }),
  ];
  const r = allocateProgramBudget(topics, { totalHoursPerWeek: 2, totalWeeks: 6 });
  check('kept 2 (budget floor)', r.topics.length === 2, r.topics.map((t) => t.key));
  check('nice_to_have dropped despite high weight', r.topics.every((t) => t.key !== 'extra'));
  check('drop reason budget_floor', r.dropped.length === 1 && r.dropped[0].reason === 'budget_floor');
  check('each kept gets floor 1', JSON.stringify(r.topics.map((t) => t.hoursPerWeek)) === '[1,1]');
}

console.log('allocateProgramBudget — always keeps ≥1 topic even below floor sum');
{
  const r = allocateProgramBudget([T('only', { priorityTier: PriorityTier.nice_to_have })], {
    totalHoursPerWeek: 1,
    totalWeeks: 4,
  });
  check('one kept', r.topics.length === 1 && r.topics[0].hoursPerWeek === 1);
}

// --- planProgram wiring (stubbed decompose + gate) --------------------------
const proposed = (over: Partial<ProposedTopic>): ProposedTopic => ({
  topic: 'x',
  weight: 1,
  priorityTier: 'core',
  phaseLabel: 'P1',
  orderHint: 1,
  rationale: 'r',
  ...over,
});
// A stub gate: slugify the label; reject anything containing "cooking".
const stubGate = async (topic: string): Promise<TopicGateResult> => {
  if (topic.toLowerCase().includes('cooking')) return { valid: false, reason: 'out of domain' };
  return { valid: true, canonical: topic.toLowerCase().replace(/\s+/g, '-'), subject: 'cs' };
};

async function main() {
  console.log('planProgram — gate drops out-of-domain topics');
  {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 10, totalWeeks: 10 },
      {
        decompose: async () => [
          proposed({ topic: 'Python', weight: 3 }),
          proposed({ topic: 'Cooking', weight: 2 }),
        ],
        gate: stubGate,
      },
    );
    check('cooking dropped by gate', plan.droppedByGate.length === 1 && plan.droppedByGate[0].topic === 'Cooking');
    check('only python planned', plan.topics.length === 1 && plan.topics[0].key === 'python');
  }

  console.log('planProgram — a gate THROW drops only that topic (after one retry), not the program');
  {
    let calls = 0;
    // Throws on the first two calls (the topic + its retry), succeeds for others.
    const flakyGate = async (topic: string): Promise<TopicGateResult> => {
      if (topic === 'flaky') {
        calls++;
        throw new Error('No object generated');
      }
      return { valid: true, canonical: topic.toLowerCase(), subject: 'cs' };
    };
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 10, totalWeeks: 10 },
      {
        decompose: async () => [proposed({ topic: 'python', weight: 3 }), proposed({ topic: 'flaky', weight: 2 })],
        gate: flakyGate,
      },
    );
    check('gate retried the throwing topic once (2 calls)', calls === 2, calls);
    check('flaky topic dropped by gate', plan.droppedByGate.some((d) => d.topic === 'flaky'));
    check('program still formed from the survivor', plan.topics.length === 1 && plan.topics[0].key === 'python');
  }

  console.log('planProgram — two labels → same canonical collapse (higher weight wins)');
  {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => [
          proposed({ topic: 'linear algebra', weight: 2, orderHint: 1 }),
          proposed({ topic: 'Linear Algebra', weight: 8, orderHint: 2 }),
          proposed({ topic: 'calculus', weight: 4, orderHint: 3 }),
        ],
        gate: stubGate,
      },
    );
    check('deduped to 2 topics', plan.topics.length === 2, plan.topics.map((t) => t.key));
    const la = plan.topics.find((t) => t.key === 'linear-algebra');
    check('merged slot kept higher weight 8', la?.weight === 8, la);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
