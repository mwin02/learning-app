// Throwaway verification for Phase 2.5e-1 pure modules (no test runner yet —
// same pattern as cycle.ts/readiness.ts were verified). Run:
//   npx tsx --env-file=.env.local scripts/verify-track-plan.ts
// Exits non-zero on the first failed assertion.

// Budget trim + closure (trimToBudget) moved to allocate.ts in 2.5e-7b; those
// cases now live in verify-allocate.ts. This covers the remaining pure helpers.
import { topoSort, layerBySlug, type OrderEdge } from '../src/lib/agents/map/order';
import { budgetMinutesFor, lessonPrereqKeys } from '../src/lib/agents/track/plan';

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

// --- budgetMinutesFor ----------------------------------------------------
console.log('budgetMinutesFor');
check('6wk x 5h = 1800 min', budgetMinutesFor(6, 5) === 1800);
check('missing timeframe → null', budgetMinutesFor(undefined, 5) === null);
check('missing hours → null', budgetMinutesFor(6, 0) === null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
