// Unit tests for allocateProgramBudget (Phase 2.75b program plan pass). Pure fixtures —
// no LLM, no DB. Migrated from scripts/verify-program-plan.ts (R1).
//
// Asserts the floor-respecting largest-remainder split: exact sum to budget, the
// maxTopics cap and budget-floor drops (nice_to_have first), and dense ordering by
// orderHint.
import { describe, it, expect } from 'vitest';
import { PriorityTier } from '@prisma/client';
import { allocateProgramBudget, type ProgramTopicInput } from '@/lib/agents/program/budget';

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

describe('allocateProgramBudget — split sums to budget, floor respected', () => {
  const r = allocateProgramBudget(
    [T('a', { weight: 3, orderHint: 1 }), T('b', { weight: 1, orderHint: 2 })],
    { totalHoursPerWeek: 10, totalWeeks: 12 },
  );

  it('keeps both topics, drops none', () => {
    expect(r.topics.length).toBe(2);
    expect(r.dropped.length).toBe(0);
  });
  it('hours sum to totalHoursPerWeek', () => {
    expect(sum(r.topics.map((t) => t.hoursPerWeek))).toBe(10);
  });
  it('every topic ≥ floor 1', () => {
    expect(r.topics.every((t) => t.hoursPerWeek >= 1)).toBe(true);
  });
  it('weighted split 7/3 (remainder 8 split 3:1 → 6/2, +floor)', () => {
    expect(r.topics.map((t) => t.hoursPerWeek)).toEqual([7, 3]);
  });
  it('timeframeWeeks = totalWeeks', () => {
    expect(r.topics.every((t) => t.timeframeWeeks === 12)).toBe(true);
  });
  it('dense order 1..M by orderHint', () => {
    expect(r.topics.map((t) => t.orderInProgram)).toEqual([1, 2]);
  });
});

describe('allocateProgramBudget — dense renumber follows orderHint, not input order', () => {
  const r = allocateProgramBudget(
    [T('late', { orderHint: 9 }), T('early', { orderHint: 1 })],
    { totalHoursPerWeek: 6, totalWeeks: 8 },
  );

  it('early topic sorts first', () => {
    expect(r.topics[0].key).toBe('early');
    expect(r.topics[0].orderInProgram).toBe(1);
  });
  it('late topic sorts second', () => {
    expect(r.topics[1].key).toBe('late');
    expect(r.topics[1].orderInProgram).toBe(2);
  });
});

describe('allocateProgramBudget — maxTopics cap drops nice_to_have first', () => {
  const r = allocateProgramBudget(
    [
      T('a', { weight: 5, priorityTier: PriorityTier.core }),
      T('b', { weight: 4, priorityTier: PriorityTier.core }),
      T('c', { weight: 3, priorityTier: PriorityTier.nice_to_have }),
      T('d', { weight: 2, priorityTier: PriorityTier.nice_to_have }),
    ],
    { totalHoursPerWeek: 20, totalWeeks: 10, maxTopics: 2 },
  );

  it('caps to 2', () => {
    expect(r.topics.length).toBe(2);
  });
  it('keeps the two core topics', () => {
    expect(r.topics.map((t) => t.key).sort()).toEqual(['a', 'b']);
  });
  it('drops c,d as over_max_topics', () => {
    expect(r.dropped.length).toBe(2);
    expect(r.dropped.every((d) => d.reason === 'over_max_topics')).toBe(true);
  });
});

describe('allocateProgramBudget — tight budget drops on floor (nice_to_have before core)', () => {
  // floor=1, budget=2 → only 2 topics fit; 3 proposed → drop the 1 nice_to_have.
  const r = allocateProgramBudget(
    [
      T('core1', { weight: 5, priorityTier: PriorityTier.core }),
      T('core2', { weight: 4, priorityTier: PriorityTier.core }),
      T('extra', { weight: 9, priorityTier: PriorityTier.nice_to_have }),
    ],
    { totalHoursPerWeek: 2, totalWeeks: 6 },
  );

  it('keeps 2 (budget floor)', () => {
    expect(r.topics.length).toBe(2);
  });
  it('drops the nice_to_have despite its high weight', () => {
    expect(r.topics.every((t) => t.key !== 'extra')).toBe(true);
  });
  it('drop reason is budget_floor', () => {
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0].reason).toBe('budget_floor');
  });
  it('each kept topic gets floor 1', () => {
    expect(r.topics.map((t) => t.hoursPerWeek)).toEqual([1, 1]);
  });
});

describe('allocateProgramBudget — always keeps ≥1 topic even below floor sum', () => {
  it('keeps the lone topic at floor 1', () => {
    const r = allocateProgramBudget([T('only', { priorityTier: PriorityTier.nice_to_have })], {
      totalHoursPerWeek: 1,
      totalWeeks: 4,
    });
    expect(r.topics.length).toBe(1);
    expect(r.topics[0].hoursPerWeek).toBe(1);
  });
});
