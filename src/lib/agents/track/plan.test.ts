// Unit tests for the pure track/plan helpers lessonPrereqKeys + budgetMinutesFor
// (Phase 2.5e-1). No DB, no LLM. Migrated from scripts/verify-track-plan.ts (R2).
import { describe, it, expect } from 'vitest';
import type { OrderEdge } from '@/lib/agents/map/order';
import { budgetMinutesFor, lessonPrereqKeys } from '@/lib/agents/track/plan';

describe('lessonPrereqKeys', () => {
  // Lessons: L1=[a], L2=[b,c] (merged), L3=[d]; internal L2 edge (b→c) must be ignored.
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

  it('L2 depends on L1', () => expect(deps.get('L2')).toEqual(['L1']));
  it('L3 depends on L2', () => expect(deps.get('L3')).toEqual(['L2']));
  it('L1 has no prereqs', () => expect(deps.get('L1')!.length).toBe(0));
  it('internal merged edge ignored (L2 not self-dep)', () => expect(deps.get('L2')!).not.toContain('L2'));
});

describe('budgetMinutesFor', () => {
  it('6wk x 5h = 1800 min', () => expect(budgetMinutesFor(6, 5)).toBe(1800));
  it('missing timeframe → null', () => expect(budgetMinutesFor(undefined, 5)).toBeNull());
  it('missing hours → null', () => expect(budgetMinutesFor(6, 0)).toBeNull());
});
