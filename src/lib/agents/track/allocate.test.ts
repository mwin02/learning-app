// Unit tests for the pure Track allocator (Phase 2.5e-7a). No DB, no LLM. Migrated
// from scripts/verify-allocate.ts (R2).
//
// Asserts breadth (closure-aware trim at floor cost) + depth (weight-sliced,
// mandatory-rank-first, ≥1) behavior and the largest-remainder slice arithmetic.
import { describe, it, expect } from 'vitest';
import {
  allocate,
  allotByWeight,
  type AllocatorLesson,
  type AllocatorCandidate,
} from '@/lib/agents/track/allocate';

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

describe('allotByWeight — exact sum + proportional + largest-remainder', () => {
  it('even split', () => {
    expect(allotByWeight(100, [1, 1])).toEqual([50, 50]);
  });
  it('sums to budget and largest remainders get the leftover', () => {
    const s = allotByWeight(100, [1, 2, 4, 8]); // exact 6.67/13.3/26.7/53.3
    expect(s.reduce((a, b) => a + b, 0)).toBe(100);
    expect(s).toEqual([7, 13, 27, 53]);
  });
  it('zero budget → all zero', () => {
    expect(allotByWeight(0, [1, 2])).toEqual([0, 0]);
  });
  it('zero weights → all zero', () => {
    expect(allotByWeight(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('allocate — null budget keeps everything, full mandatory core as primaries', () => {
  const lessons = [
    L('a', { mandatory: [c('a1', 30), c('a2', 20)], optional: [c('ax', 10)] }),
    L('b', { mandatory: [c('b1', 15)], optional: [] }),
  ];
  const r = allocate({ lessons, budgetMinutes: null });

  it('keeps both lessons', () => expect(r.kept.length).toBe(2));
  it('a: full core primary', () => expect(ids(byKey(r, 'a').primaries)).toEqual(['a1', 'a2']));
  it('a: optional → alternate', () => expect(ids(byKey(r, 'a').alternates)).toEqual(['ax']));
  it('a: slice null', () => expect(byKey(r, 'a').sliceMinutes).toBeNull());
  it('total = 30+20+15', () => expect(r.totalMinutes).toBe(65));
  it('not depth-constrained', () => expect(r.depthConstrained).toBe(false));
});

describe('allocate — depth by weight + ≥1 guarantee + rank-first + optional-not-promoted', () => {
  // deep(8) lesson affords its whole core; low(1) lesson gets only the ≥1 even
  // though its first mandatory overflows the tiny slice (rank-first demotes the tail).
  const lessons = [
    L('deep', { timeWeight: 'deep', mandatory: [c('p1', 10), c('p2', 10), c('p3', 10)], optional: [c('o1', 5)] }),
    L('low', { timeWeight: 'low', mandatory: [c('q1', 40), c('q2', 10)], optional: [c('o2', 5)] }),
  ];
  const r = allocate({ lessons, budgetMinutes: 90 }); // Σw=9 → slices 80 / 10
  const deep = byKey(r, 'deep');
  const low = byKey(r, 'low');

  it('slices 80 / 10', () => {
    expect(deep.sliceMinutes).toBe(80);
    expect(low.sliceMinutes).toBe(10);
  });
  it('deep: full core, in rank order', () => expect(ids(deep.primaries)).toEqual(['p1', 'p2', 'p3']));
  it('deep: optional stays alternate (not promoted despite spare slice)', () =>
    expect(ids(deep.alternates)).toEqual(['o1']));
  it('low: only the ≥1 primary (overflows slice, allowed)', () => expect(ids(low.primaries)).toEqual(['q1']));
  it('low: tail then pool demoted in order', () => expect(ids(low.alternates)).toEqual(['q2', 'o2']));
  it('depthConstrained flagged (low core trimmed)', () => expect(r.depthConstrained).toBe(true));
  it('est: deep=30, low=40', () => {
    expect(deep.estMinutes).toBe(30);
    expect(low.estMinutes).toBe(40);
  });
});

describe('allocate — breadth: frontier dropped when floor unaffordable; spine always kept', () => {
  const lessons = [
    L('S', { mandatory: [c('s', 30)] }),
    L('F1', { isFrontier: true, masteryRelevant: true, mandatory: [c('f1', 30)] }),
    L('F2', { isFrontier: true, mandatory: [c('f2', 30)] }),
  ];
  const r = allocate({ lessons, budgetMinutes: 50 }); // floor S=30, neither frontier fits

  it('only spine kept', () => expect(r.kept.map((l) => l.key)).toEqual(['S']));
  it('both frontier dropped', () => expect(r.dropped.length).toBe(2));
  it('droppedMasteryRelevant (F1)', () => expect(r.droppedMasteryRelevant).toBe(true));
  it('budgetWeak', () => expect(r.budgetWeak).toBe(true));
});

describe('allocate — breadth priority: a mastery-relevant frontier is kept before a less-relevant one', () => {
  // Spine floor 10; budget 22 → cap 24.2, room for exactly ONE 10-floor frontier
  // (20 ≤ 24.2), not both (30). The less-relevant frontier comes FIRST in teaching
  // order, so input order alone would keep it — mastery-relevance must override that.
  const lessons = [
    L('S', { mandatory: [c('s', 10)] }),
    L('Firrel', { isFrontier: true, masteryRelevant: false, mandatory: [c('fi', 10)] }),
    L('Frel', { isFrontier: true, masteryRelevant: true, mandatory: [c('fr', 10)] }),
  ];
  const r = allocate({ lessons, budgetMinutes: 22 });

  it('relevant frontier kept over the earlier less-relevant one', () => {
    expect(r.kept.some((l) => l.key === 'Frel')).toBe(true);
    expect(r.kept.some((l) => l.key === 'Firrel')).toBe(false);
  });
  it('the dropped frontier is the non-relevant one', () => expect(r.droppedMasteryRelevant).toBe(false));
  it('kept stays in teaching order (S before any frontier), not relevance', () =>
    expect(r.kept.map((l) => l.key)).toEqual(['S', 'Frel']));
});

describe('allocate — closure: a kept frontier never orphans its frontier prereq', () => {
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

  it('Fdep skipped despite its own floor fitting', () => expect(r.kept.some((l) => l.key === 'Fdep')).toBe(false));
  it('Fbase not kept either', () => expect(r.kept.some((l) => l.key === 'Fbase')).toBe(false));
  it('only A kept', () => expect(r.kept.map((l) => l.key)).toEqual(['A']));
});

describe('allocate — spineOverBudget: required floor exceeds budget, spine kept anyway', () => {
  const lessons = [L('A', { mandatory: [c('a', 60)] })];
  const r = allocate({ lessons, budgetMinutes: 50 });

  it('spineOverBudget', () => expect(r.spineOverBudget).toBe(true));
  it('spine still kept (never trimmed)', () => {
    expect(r.kept.length).toBe(1);
    expect(r.kept[0].key).toBe('A');
  });
  it('budgetWeak', () => expect(r.budgetWeak).toBe(true));
});

describe('allocate — depth slack: a barely-over core resource is admitted (not demoted)', () => {
  // Single normal lesson → slice = whole budget (53). p2 pushes used to 55, which is
  // over 53 but within the 10% slack (58.3), so it stays a primary.
  const lessons = [L('a', { mandatory: [c('p1', 50), c('p2', 5)] })];

  it('p2 admitted under slack; not depth-constrained', () => {
    const lax = allocate({ lessons, budgetMinutes: 53 }); // default 10% slack
    expect(ids(byKey(lax, 'a').primaries)).toEqual(['p1', 'p2']);
    expect(lax.depthConstrained).toBe(false);
  });
  it('slackPct:0 demotes p2 (strict cliff) → depth-constrained', () => {
    const strict = allocate({ lessons, budgetMinutes: 53, slackPct: 0 });
    expect(ids(byKey(strict, 'a').primaries)).toEqual(['p1']);
    expect(strict.depthConstrained).toBe(true);
  });
});

describe('allocate — breadth slack: a barely-over frontier lesson is kept (not dropped)', () => {
  const lessons = [
    L('S', { mandatory: [c('s', 50)] }),
    L('F', { isFrontier: true, masteryRelevant: true, mandatory: [c('f', 8)] }),
  ];

  it('F kept under slack; no mastery-relevant drop', () => {
    const lax = allocate({ lessons, budgetMinutes: 55 }); // floor 50+8=58 ≤ 55×1.1=60.5
    expect(lax.kept.some((l) => l.key === 'F')).toBe(true);
    expect(lax.droppedMasteryRelevant).toBe(false);
  });
  it('slackPct:0 drops F (58 > 55) → droppedMasteryRelevant', () => {
    const strict = allocate({ lessons, budgetMinutes: 55, slackPct: 0 });
    expect(strict.kept.some((l) => l.key === 'F')).toBe(false);
    expect(strict.droppedMasteryRelevant).toBe(true);
  });
});

describe('allocate — mandatory empty: optional[0] promoted to the ≥1 primary', () => {
  const lessons = [L('a', { mandatory: [], optional: [c('o', 10), c('o2', 5)] })];
  const r = allocate({ lessons, budgetMinutes: null });

  it('optional[0] is the primary', () => expect(ids(byKey(r, 'a').primaries)).toEqual(['o']));
  it('rest of optional → alternates', () => expect(ids(byKey(r, 'a').alternates)).toEqual(['o2']));
});
