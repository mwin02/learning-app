// Throwaway verification for Phase 2.5e-7a (the pure Track allocator).
//   npx tsx --env-file=.env.local scripts/verify-allocate.ts
//
// Pure fixtures only — no DB, no LLM. Asserts the breadth (closure-aware trim at
// floor cost) + depth (weight-sliced, mandatory-rank-first, ≥1) behavior and the
// largest-remainder slice arithmetic.

import {
  allocate,
  allotByWeight,
  type AllocatorLesson,
  type AllocatorCandidate,
} from '../src/lib/agents/track/allocate';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}
const ids = (cs: AllocatorCandidate[]) => cs.map((c) => c.resourceId);
const c = (resourceId: string, durationMin: number): AllocatorCandidate => ({ resourceId, durationMin });
const L = (key: string, over: Partial<AllocatorLesson> = {}): AllocatorLesson => ({
  key,
  isFrontier: false,
  masteryRelevant: false,
  timeWeight: 'normal',
  mandatory: [],
  optional: [],
  ...over,
});
const byKey = (r: ReturnType<typeof allocate>, key: string) => r.kept.find((l) => l.key === key)!;

console.log('allotByWeight — exact sum + proportional + largest-remainder');
{
  check('even split', JSON.stringify(allotByWeight(100, [1, 1])) === '[50,50]', allotByWeight(100, [1, 1]));
  const s = allotByWeight(100, [1, 2, 4, 8]); // exact 6.67/13.3/26.7/53.3
  check('sums to budget', s.reduce((a, b) => a + b, 0) === 100, s);
  check('largest remainders get the leftover', JSON.stringify(s) === '[7,13,27,53]', s);
  check('zero budget → all zero', JSON.stringify(allotByWeight(0, [1, 2])) === '[0,0]');
  check('zero weights → all zero', JSON.stringify(allotByWeight(10, [0, 0])) === '[0,0]');
}

console.log('allocate — null budget keeps everything, full mandatory core as primaries');
{
  const lessons = [
    L('a', { mandatory: [c('a1', 30), c('a2', 20)], optional: [c('ax', 10)] }),
    L('b', { mandatory: [c('b1', 15)], optional: [] }),
  ];
  const r = allocate({ lessons, budgetMinutes: null });
  check('both kept', r.kept.length === 2);
  check('a: full core primary', JSON.stringify(ids(byKey(r, 'a').primaries)) === '["a1","a2"]');
  check('a: optional → alternate', JSON.stringify(ids(byKey(r, 'a').alternates)) === '["ax"]');
  check('a: slice null', byKey(r, 'a').sliceMinutes === null);
  check('total = 30+20+15', r.totalMinutes === 65, r.totalMinutes);
  check('not depth-constrained', r.depthConstrained === false);
}

console.log('allocate — depth by weight + ≥1 guarantee + rank-first + optional-not-promoted');
{
  // deep(8) lesson affords its whole core; low(1) lesson gets only the ≥1 even
  // though its first mandatory overflows the tiny slice (rank-first demotes the tail).
  const lessons = [
    L('deep', { timeWeight: 'deep', mandatory: [c('p1', 10), c('p2', 10), c('p3', 10)], optional: [c('o1', 5)] }),
    L('low', { timeWeight: 'low', mandatory: [c('q1', 40), c('q2', 10)], optional: [c('o2', 5)] }),
  ];
  const r = allocate({ lessons, budgetMinutes: 90 }); // Σw=9 → slices 80 / 10
  const deep = byKey(r, 'deep');
  const low = byKey(r, 'low');
  check('slices 80 / 10', deep.sliceMinutes === 80 && low.sliceMinutes === 10, [deep.sliceMinutes, low.sliceMinutes]);
  check('deep: full core, in rank order', JSON.stringify(ids(deep.primaries)) === '["p1","p2","p3"]', ids(deep.primaries));
  check('deep: optional stays alternate (not promoted despite spare slice)', JSON.stringify(ids(deep.alternates)) === '["o1"]');
  check('low: only the ≥1 primary (overflows slice, allowed)', JSON.stringify(ids(low.primaries)) === '["q1"]', ids(low.primaries));
  check('low: tail then pool demoted in order', JSON.stringify(ids(low.alternates)) === '["q2","o2"]', ids(low.alternates));
  check('depthConstrained flagged (low core trimmed)', r.depthConstrained === true);
  check('est: deep=30, low=40', deep.estMinutes === 30 && low.estMinutes === 40);
}

console.log('allocate — breadth: frontier dropped when floor unaffordable; spine always kept');
{
  const lessons = [
    L('S', { mandatory: [c('s', 30)] }),
    L('F1', { isFrontier: true, masteryRelevant: true, mandatory: [c('f1', 30)] }),
    L('F2', { isFrontier: true, mandatory: [c('f2', 30)] }),
  ];
  const r = allocate({ lessons, budgetMinutes: 50 }); // floor S=30, neither frontier fits
  check('only spine kept', JSON.stringify(r.kept.map((l) => l.key)) === '["S"]', r.kept.map((l) => l.key));
  check('both frontier dropped', r.dropped.length === 2);
  check('droppedMasteryRelevant (F1)', r.droppedMasteryRelevant === true);
  check('budgetWeak', r.budgetWeak === true);
}

console.log('allocate — closure: a kept frontier never orphans its frontier prereq');
{
  // order Fdep before Fbase; Fdep depends on Fbase. Fdep's own floor (5) fits the
  // remaining budget, but its closure (Fdep+Fbase = 35) does not — so Fdep is
  // skipped rather than kept without its prerequisite.
  const lessons = [
    L('A', { mandatory: [c('a', 10)] }),
    L('Fdep', { isFrontier: true, masteryRelevant: true, mandatory: [c('fd', 5)] }),
    L('Fbase', { isFrontier: true, mandatory: [c('fb', 30)] }),
  ];
  const prereqKeys = new Map<string, string[]>([['Fdep', ['Fbase']]]);
  const r = allocate({ lessons, budgetMinutes: 20, prereqKeys }); // floor A=10, 10 left
  check('Fdep skipped despite its own floor fitting', !r.kept.some((l) => l.key === 'Fdep'), r.kept.map((l) => l.key));
  check('Fbase not kept either', !r.kept.some((l) => l.key === 'Fbase'));
  check('only A kept', JSON.stringify(r.kept.map((l) => l.key)) === '["A"]', r.kept.map((l) => l.key));
}

console.log('allocate — spineOverBudget: required floor exceeds budget, spine kept anyway');
{
  const lessons = [L('A', { mandatory: [c('a', 60)] })];
  const r = allocate({ lessons, budgetMinutes: 50 });
  check('spineOverBudget', r.spineOverBudget === true);
  check('spine still kept (never trimmed)', r.kept.length === 1 && r.kept[0].key === 'A');
  check('budgetWeak', r.budgetWeak === true);
}

console.log('allocate — depth slack: a barely-over core resource is admitted (not demoted)');
{
  // Single normal lesson → slice = whole budget (53). p2 pushes used to 55, which is
  // over 53 but within the 10% slack (58.3), so it stays a primary.
  const lessons = [L('a', { mandatory: [c('p1', 50), c('p2', 5)] })];
  const lax = allocate({ lessons, budgetMinutes: 53 }); // default 10% slack
  check('p2 admitted under slack', JSON.stringify(ids(byKey(lax, 'a').primaries)) === '["p1","p2"]', ids(byKey(lax, 'a').primaries));
  check('not depth-constrained under slack', lax.depthConstrained === false);
  const strict = allocate({ lessons, budgetMinutes: 53, slackPct: 0 });
  check('slackPct:0 demotes p2 (strict cliff)', JSON.stringify(ids(byKey(strict, 'a').primaries)) === '["p1"]', ids(byKey(strict, 'a').primaries));
  check('slackPct:0 → depth-constrained', strict.depthConstrained === true);
}

console.log('allocate — breadth slack: a barely-over frontier lesson is kept (not dropped)');
{
  const lessons = [
    L('S', { mandatory: [c('s', 50)] }),
    L('F', { isFrontier: true, masteryRelevant: true, mandatory: [c('f', 8)] }),
  ];
  const lax = allocate({ lessons, budgetMinutes: 55 }); // floor 50+8=58 ≤ 55×1.1=60.5
  check('F kept under slack', lax.kept.some((l) => l.key === 'F'), lax.kept.map((l) => l.key));
  check('no mastery-relevant drop under slack', lax.droppedMasteryRelevant === false);
  const strict = allocate({ lessons, budgetMinutes: 55, slackPct: 0 });
  check('slackPct:0 drops F (58 > 55)', !strict.kept.some((l) => l.key === 'F'), strict.kept.map((l) => l.key));
  check('slackPct:0 → droppedMasteryRelevant', strict.droppedMasteryRelevant === true);
}

console.log('allocate — mandatory empty: optional[0] promoted to the ≥1 primary');
{
  const lessons = [L('a', { mandatory: [], optional: [c('o', 10), c('o2', 5)] })];
  const r = allocate({ lessons, budgetMinutes: null });
  check('optional[0] is the primary', JSON.stringify(ids(byKey(r, 'a').primaries)) === '["o"]', ids(byKey(r, 'a').primaries));
  check('rest of optional → alternates', JSON.stringify(ids(byKey(r, 'a').alternates)) === '["o2"]');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
