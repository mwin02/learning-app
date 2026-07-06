// Unit tests for the pure concept-merge planner (Pre-Freeze Map Review, Block 3).
// No DB — just the repoint/dedupe/cycle logic. Concept ids are single letters (w =
// winner, l = loser, others neighbours) for readability.
import { describe, it, expect } from 'vitest';
import { planConceptMerge } from '@/lib/agents/map/merge-concept';

describe('planConceptMerge — resource links', () => {
  it('moves the loser links the winner lacks and drops the ones it already has', () => {
    const plan = planConceptMerge({
      winnerId: 'w',
      loserId: 'l',
      edges: [],
      winnerResourceIds: new Set(['r-shared']),
      loserResourceLinks: [
        { id: 'link-new', resourceId: 'r-new' },
        { id: 'link-dup', resourceId: 'r-shared' },
      ],
    });
    expect(plan.resourceLinkIdsToMove).toEqual(['link-new']);
  });
});

describe('planConceptMerge — edges', () => {
  it('repoints loser in/out edges onto the winner', () => {
    // p → l (prereq), l → d (dependent). After merge: p → w, w → d.
    const plan = planConceptMerge({
      winnerId: 'w',
      loserId: 'l',
      edges: [
        { fromConceptId: 'p', toConceptId: 'l' },
        { fromConceptId: 'l', toConceptId: 'd' },
      ],
      winnerResourceIds: new Set(),
      loserResourceLinks: [],
    });
    expect(plan.edgesToCreate).toEqual([
      { fromConceptId: 'p', toConceptId: 'w' },
      { fromConceptId: 'w', toConceptId: 'd' },
    ]);
    expect(plan.wouldCycle).toBe(false);
  });

  it('drops the collapsed winner↔loser edge (would be a self-loop)', () => {
    const plan = planConceptMerge({
      winnerId: 'w',
      loserId: 'l',
      edges: [{ fromConceptId: 'w', toConceptId: 'l' }],
      winnerResourceIds: new Set(),
      loserResourceLinks: [],
    });
    expect(plan.edgesToCreate).toEqual([]);
  });

  it('dedupes an edge the winner already has', () => {
    // p → w exists; p → l would repoint to p → w (already present) → not recreated.
    const plan = planConceptMerge({
      winnerId: 'w',
      loserId: 'l',
      edges: [
        { fromConceptId: 'p', toConceptId: 'w' },
        { fromConceptId: 'p', toConceptId: 'l' },
      ],
      winnerResourceIds: new Set(),
      loserResourceLinks: [],
    });
    expect(plan.edgesToCreate).toEqual([]);
  });
});

describe('planConceptMerge — cycle guard', () => {
  it('flags a merge that would create a cycle', () => {
    // w → m → l. Merging l into w repoints m → l to m → w, closing w → m → w.
    const plan = planConceptMerge({
      winnerId: 'w',
      loserId: 'l',
      edges: [
        { fromConceptId: 'w', toConceptId: 'm' },
        { fromConceptId: 'm', toConceptId: 'l' },
      ],
      winnerResourceIds: new Set(),
      loserResourceLinks: [],
    });
    expect(plan.edgesToCreate).toEqual([{ fromConceptId: 'm', toConceptId: 'w' }]);
    expect(plan.wouldCycle).toBe(true);
  });

  it('does not flag an acyclic merge', () => {
    const plan = planConceptMerge({
      winnerId: 'w',
      loserId: 'l',
      edges: [
        { fromConceptId: 'a', toConceptId: 'l' },
        { fromConceptId: 'l', toConceptId: 'b' },
        { fromConceptId: 'a', toConceptId: 'w' },
      ],
      winnerResourceIds: new Set(),
      loserResourceLinks: [],
    });
    expect(plan.wouldCycle).toBe(false);
  });
});
