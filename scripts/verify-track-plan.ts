// Throwaway verification for Phase 2.5e-1 pure modules (no test runner yet —
// same pattern as cycle.ts/readiness.ts were verified). Run:
//   npx tsx --env-file=.env.local scripts/verify-track-plan.ts
// Exits non-zero on the first failed assertion.

import { topoSort, layerBySlug, type OrderEdge } from '../src/lib/agents/map/order';
import { trimToBudget, budgetMinutesFor, lessonPrereqKeys, type PlannableLesson } from '../src/lib/agents/track/plan';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

// --- topoSort ------------------------------------------------------------
// Diamond: a → b, a → c, b → d, c → d. Plus isolated node `e`.
const concepts = ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ slug }));
const edges: OrderEdge[] = [
  { fromSlug: 'a', toSlug: 'b' },
  { fromSlug: 'a', toSlug: 'c' },
  { fromSlug: 'b', toSlug: 'd' },
  { fromSlug: 'c', toSlug: 'd' },
];

console.log('topoSort');
const order = topoSort(concepts, edges);
const pos = new Map(order.map((s, i) => [s, i]));
check('contains every concept', order.length === 5 && new Set(order).size === 5, order);
check('respects every edge (from before to)', edges.every((e) => pos.get(e.fromSlug)! < pos.get(e.toSlug)!), order);
check('isolated node present', order.includes('e'));
check('deterministic across runs', JSON.stringify(topoSort(concepts, edges)) === JSON.stringify(order), order);
check('deterministic tie-break (a first, then b before c)', order[0] === 'a' && pos.get('b')! < pos.get('c')!, order);

// Cycle defense: a → b → a should not loop; both still appear.
const cyc = topoSort([{ slug: 'a' }, { slug: 'b' }], [
  { fromSlug: 'a', toSlug: 'b' },
  { fromSlug: 'b', toSlug: 'a' },
]);
check('cycle does not hang, all nodes appended', cyc.length === 2 && new Set(cyc).size === 2, cyc);

// --- layerBySlug ---------------------------------------------------------
console.log('layerBySlug');
const layers = layerBySlug(concepts, edges);
check('root layer 0', layers.get('a') === 0, [...layers]);
check('direct deps layer 1', layers.get('b') === 1 && layers.get('c') === 1, [...layers]);
check('diamond sink layer 2 (longest path)', layers.get('d') === 2, [...layers]);
check('isolated node layer 0', layers.get('e') === 0, [...layers]);

// --- trimToBudget --------------------------------------------------------
console.log('trimToBudget');
const lessons: PlannableLesson[] = [
  { key: 's1', isFrontier: false, masteryRelevant: false, estMinutes: 60 },
  { key: 's2', isFrontier: false, masteryRelevant: false, estMinutes: 60 },
  { key: 'f1', isFrontier: true, masteryRelevant: true, estMinutes: 60 },
  { key: 'f2', isFrontier: true, masteryRelevant: true, estMinutes: 60 },
  { key: 'f3', isFrontier: true, masteryRelevant: false, estMinutes: 60 },
];

// Budget 180: spine (120) + one frontier (60) fits; f2, f3 dropped.
const r1 = trimToBudget(lessons, 180);
check('spine always kept', r1.kept.filter((l) => !l.isFrontier).length === 2, r1.kept.map((l) => l.key));
check('keeps frontier that fits (f1)', r1.kept.some((l) => l.key === 'f1'), r1.kept.map((l) => l.key));
check('drops overflow frontier (f2,f3)', r1.dropped.map((l) => l.key).sort().join() === 'f2,f3', r1.dropped.map((l) => l.key));
check('totalMinutes = 180', r1.totalMinutes === 180, r1.totalMinutes);
check('droppedMasteryRelevant true (f2 was relevant)', r1.droppedMasteryRelevant === true);
check('budgetWeak true', r1.budgetWeak === true);
check('not spineOverBudget', r1.spineOverBudget === false);

// Null budget: keep everything, no weakness.
const r2 = trimToBudget(lessons, null);
check('null budget keeps all', r2.kept.length === 5 && r2.dropped.length === 0);
check('null budget not weak', r2.budgetWeak === false);

// Spine alone over budget (100 < 120): all frontier dropped, spine kept, weak.
const r3 = trimToBudget(lessons, 100);
check('spineOverBudget keeps full spine', r3.kept.length === 2 && r3.kept.every((l) => !l.isFrontier));
check('spineOverBudget flag set', r3.spineOverBudget === true);
check('spineOverBudget is budgetWeak', r3.budgetWeak === true);
check('totalMinutes can exceed budget (120 > 100)', r3.totalMinutes === 120, r3.totalMinutes);

// Only a non-mastery frontier dropped → weak by drop but not mastery-relevant.
const lessons2: PlannableLesson[] = [
  { key: 's1', isFrontier: false, masteryRelevant: false, estMinutes: 60 },
  { key: 'f1', isFrontier: true, masteryRelevant: false, estMinutes: 60 },
];
const r4 = trimToBudget(lessons2, 60); // spine 60 = budget; f1 drops
check('non-mastery frontier drop → not droppedMasteryRelevant', r4.droppedMasteryRelevant === false);
check('non-mastery frontier drop, spine fits exactly → not weak', r4.budgetWeak === false, r4);

// --- lessonPrereqKeys ----------------------------------------------------
console.log('lessonPrereqKeys');
{
  // Lessons: L1=[a], L2=[b,c] (merged), L3=[d]; edges a→b, c→d (internal b? no).
  const ls = [
    { key: 'L1', conceptSlugs: ['a'] },
    { key: 'L2', conceptSlugs: ['b', 'c'] },
    { key: 'L3', conceptSlugs: ['d'] },
  ];
  const es: OrderEdge[] = [
    { fromSlug: 'a', toSlug: 'b' }, // L2 depends on L1
    { fromSlug: 'c', toSlug: 'd' }, // L3 depends on L2
    { fromSlug: 'b', toSlug: 'c' }, // internal to L2 — must be ignored (self)
  ];
  const deps = lessonPrereqKeys(ls, es);
  check('L2 depends on L1', JSON.stringify(deps.get('L2')) === '["L1"]', [...deps]);
  check('L3 depends on L2', JSON.stringify(deps.get('L3')) === '["L2"]', [...deps]);
  check('L1 has no prereqs', deps.get('L1')!.length === 0);
  check('internal merged edge ignored (L2 not self-dep)', !deps.get('L2')!.includes('L2'));
}

// --- closure-aware trim (2.5e-2b) ----------------------------------------
console.log('trimToBudget — prerequisite closure');
{
  // Frontier chain: f2 depends on f1 (both frontier, both mastery-relevant).
  // spine s1 (60). Budget fits s1 + ONE 60-min frontier only.
  const chain: PlannableLesson[] = [
    { key: 's1', isFrontier: false, masteryRelevant: false, estMinutes: 60 },
    { key: 'f1', isFrontier: true, masteryRelevant: true, estMinutes: 60 },
    { key: 'f2', isFrontier: true, masteryRelevant: true, estMinutes: 60 },
  ];
  const deps = new Map([['f2', ['f1']]]); // f2 needs f1
  const r = trimToBudget(chain, 120, deps);
  const kept = new Set(r.kept.map((l) => l.key));
  check('never keep f2 without f1', !(kept.has('f2') && !kept.has('f1')), [...kept]);
  check('keeps the independent prereq f1 (fits)', kept.has('f1'), [...kept]);
  check('drops f2 (its closure f1+f2 overflows)', !kept.has('f2'), [...kept]);
}
{
  // Frontier→spine edge: spine s1 depends on frontier f0. f0 is load-bearing and
  // must be kept even though it's frontier and even over a tight budget.
  const fg: PlannableLesson[] = [
    { key: 'f0', isFrontier: true, masteryRelevant: false, estMinutes: 60 },
    { key: 's1', isFrontier: false, masteryRelevant: false, estMinutes: 60 },
  ];
  const deps = new Map([['s1', ['f0']]]); // spine depends on frontier
  const r = trimToBudget(fg, 30, deps); // budget below even the required floor
  const kept = new Set(r.kept.map((l) => l.key));
  check('forced frontier f0 kept (spine depends on it)', kept.has('f0'), [...kept]);
  check('spine s1 kept', kept.has('s1'));
  check('required floor includes forced frontier → spineOverBudget', r.spineOverBudget === true, r);
  check('f0 not in dropped', !r.dropped.some((l) => l.key === 'f0'));
}

// --- budgetMinutesFor ----------------------------------------------------
console.log('budgetMinutesFor');
check('6wk x 5h = 1800 min', budgetMinutesFor(6, 5) === 1800);
check('missing timeframe → null', budgetMinutesFor(undefined, 5) === null);
check('missing hours → null', budgetMinutesFor(6, 0) === null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
