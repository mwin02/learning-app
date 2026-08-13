import { describe, it, expect } from 'vitest';
import {
  sameConcepts,
  isTopicShape,
  isParentEcho,
  selectContaminated,
  selectSharedArrays,
  selectRepairTargets,
  libraryIsStamped,
  findChunkAlignedRuns,
  classifyExistingOrigin,
  type RepairRow,
} from '@/lib/curation/concept-repair';

function row(over: Partial<RepairRow> = {}): RepairRow {
  return {
    id: 'r1',
    topic: 'calculus',
    conceptsTaught: ['limits'],
    conceptOrigin: 'inherited',
    orderInParent: 0,
    parentResourceId: 'p1',
    parentConcepts: ['derivatives', 'integrals'],
    ...over,
  };
}

describe('sameConcepts', () => {
  it('is true for identical arrays', () => {
    expect(sameConcepts(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('is order-sensitive — a reordered array is not a copy', () => {
    expect(sameConcepts(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('distinguishes a prefix from the whole', () => {
    expect(sameConcepts(['a'], ['a', 'b'])).toBe(false);
  });

  it('treats two empty arrays as equal', () => {
    expect(sameConcepts([], [])).toBe(true);
  });
});

describe('isParentEcho', () => {
  it('flags a child carrying its parent’s exact array', () => {
    expect(isParentEcho(row({ conceptsTaught: ['derivatives', 'integrals'] }))).toBe(true);
  });

  it('does not flag a child with its own tags', () => {
    expect(isParentEcho(row())).toBe(false);
  });

  it('never flags a root — there is nothing above it to have copied', () => {
    expect(
      isParentEcho(row({ parentResourceId: null, parentConcepts: null, conceptsTaught: [] })),
    ).toBe(false);
  });
});

describe('selectContaminated', () => {
  it('returns exactly the parent-echo rows', () => {
    const rows = [
      row({ id: 'a', conceptsTaught: ['derivatives', 'integrals'] }),
      row({ id: 'b' }),
      row({ id: 'c', conceptsTaught: ['integrals', 'derivatives'] }),
      row({ id: 'd', parentResourceId: null, parentConcepts: null }),
    ];
    expect(selectContaminated(rows).map((r) => r.id)).toEqual(['a']);
  });
});

describe('selectSharedArrays', () => {
  it('includes siblings sharing an array even when the parent differs', () => {
    const rows = [
      row({ id: 'a', conceptsTaught: ['series'] }),
      row({ id: 'b', conceptsTaught: ['series'] }),
      row({ id: 'c', conceptsTaught: ['limits'] }),
    ];
    expect(selectSharedArrays(rows).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('does not treat identical arrays under DIFFERENT parents as sharing', () => {
    const rows = [
      row({ id: 'a', parentResourceId: 'p1', conceptsTaught: ['series'] }),
      row({ id: 'b', parentResourceId: 'p2', conceptsTaught: ['series'] }),
    ];
    expect(selectSharedArrays(rows)).toEqual([]);
  });

  it('is a superset of the contaminated set', () => {
    const rows = [
      row({ id: 'a', conceptsTaught: ['derivatives', 'integrals'] }),
      row({ id: 'b', conceptsTaught: ['limits'] }),
    ];
    expect(selectSharedArrays(rows).map((r) => r.id)).toEqual(['a']);
  });
});

describe('libraryIsStamped', () => {
  it('is false for a pre-Q3 library where every row carries the column default', () => {
    expect(libraryIsStamped([row(), row({ id: 'b' })])).toBe(false);
  });

  it('is true once anything has asserted a verdict', () => {
    expect(libraryIsStamped([row(), row({ id: 'b', conceptOrigin: 'derived' })])).toBe(true);
  });
});

describe('selectRepairTargets', () => {
  const echo = (over: Partial<RepairRow> = {}) =>
    row({ conceptsTaught: ['derivatives', 'integrals'], ...over });

  it('takes every parent-echo on a first run, when no stamp means anything yet', () => {
    const rows = [echo({ id: 'a' }), echo({ id: 'b' }), row({ id: 'c' })];
    const { targets, unrecoverable } = selectRepairTargets(rows, {
      shared: false,
      retryInherited: false,
    });
    expect(targets.map((r) => r.id)).toEqual(['a', 'b']);
    expect(unrecoverable).toEqual([]);
  });

  it('skips an already-attempted echo once the library carries verdicts', () => {
    const rows = [echo({ id: 'a' }), row({ id: 'b', conceptOrigin: 'derived' })];
    const { targets, unrecoverable } = selectRepairTargets(rows, {
      shared: false,
      retryInherited: false,
    });
    expect(targets).toEqual([]);
    expect(unrecoverable.map((r) => r.id)).toEqual(['a']);
  });

  it('is a no-op on a second run — the idempotency property', () => {
    // A repaired row (now derived, no longer an echo) plus one the model refused.
    const afterRun = [row({ id: 'ok', conceptOrigin: 'derived' }), echo({ id: 'refused' })];
    const { targets } = selectRepairTargets(afterRun, { shared: false, retryInherited: false });
    expect(targets).toEqual([]);
  });

  it('re-attempts the refused rows under --retry-inherited', () => {
    const rows = [echo({ id: 'a' }), row({ id: 'b', conceptOrigin: 'derived' })];
    const { targets, unrecoverable } = selectRepairTargets(rows, {
      shared: false,
      retryInherited: true,
    });
    expect(targets.map((r) => r.id)).toEqual(['a']);
    expect(unrecoverable).toEqual([]);
  });

  it('widens to the shared-array set under --shared-arrays', () => {
    const rows = [
      row({ id: 'a', conceptsTaught: ['series'] }),
      row({ id: 'b', conceptsTaught: ['series'] }),
      row({ id: 'c', conceptsTaught: ['limits'] }),
    ];
    const wide = selectRepairTargets(rows, { shared: true, retryInherited: false });
    const narrow = selectRepairTargets(rows, { shared: false, retryInherited: false });
    expect(wide.targets.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(narrow.targets).toEqual([]);
  });
});

describe('findChunkAlignedRuns', () => {
  it('finds a two-batch run starting at zero', () => {
    const orders = Array.from({ length: 50 }, (_, i) => i);
    expect(findChunkAlignedRuns(orders, 25)).toEqual([{ start: 0, end: 49, length: 50 }]);
  });

  it('finds a run that does NOT start on a chunk boundary (the 2–24 case)', () => {
    const orders = Array.from({ length: 23 }, (_, i) => i + 2);
    expect(findChunkAlignedRuns(orders, 20)).toEqual([{ start: 2, end: 24, length: 23 }]);
  });

  it('finds both of a container’s two disjoint runs (the 105–124 / 225–243 case)', () => {
    const orders = [
      ...Array.from({ length: 20 }, (_, i) => i + 105),
      ...Array.from({ length: 19 }, (_, i) => i + 225),
    ];
    expect(findChunkAlignedRuns(orders, 19)).toEqual([
      { start: 105, end: 124, length: 20 },
      { start: 225, end: 243, length: 19 },
    ]);
  });

  it('ignores a run shorter than one batch', () => {
    expect(findChunkAlignedRuns([0, 1, 2], 25)).toEqual([]);
  });

  it('reports nothing once a repair has broken the run up', () => {
    expect(findChunkAlignedRuns([0, 1, 5, 6, 30], 25)).toEqual([]);
  });

  it('ignores nulls and duplicate orders rather than counting them as steps', () => {
    const orders = [null, 0, 0, 1, 2, null];
    expect(findChunkAlignedRuns(orders, 3)).toEqual([{ start: 0, end: 2, length: 3 }]);
  });
});

describe('classifyExistingOrigin', () => {
  it('stamps derived when the array differs from the parent’s', () => {
    expect(classifyExistingOrigin(row())).toBe('derived');
  });

  it('stamps inherited when the array is the parent’s exactly', () => {
    expect(classifyExistingOrigin(row({ conceptsTaught: ['derivatives', 'integrals'] }))).toBe(
      'inherited',
    );
  });

  it('stamps fallback for the [topic] shape even though it differs from the parent', () => {
    expect(classifyExistingOrigin(row({ conceptsTaught: ['calculus'] }))).toBe('fallback');
  });

  it('stamps fallback for an empty array', () => {
    expect(classifyExistingOrigin(row({ conceptsTaught: [] }))).toBe('fallback');
  });

  it('stamps a root with its own tags derived — it is outside the inheritance path', () => {
    expect(
      classifyExistingOrigin(
        row({ parentResourceId: null, parentConcepts: null, conceptsTaught: ['limits'] }),
      ),
    ).toBe('derived');
  });

  it('still stamps a root carrying the [topic] shape fallback, not derived', () => {
    expect(
      classifyExistingOrigin(
        row({ parentResourceId: null, parentConcepts: null, conceptsTaught: ['calculus'] }),
      ),
    ).toBe('fallback');
  });

  it('is stable when re-applied to a row a repair just rewrote', () => {
    const repaired = row({ conceptsTaught: ['chain-rule'] });
    expect(classifyExistingOrigin(repaired)).toBe('derived');
    expect(classifyExistingOrigin(repaired)).toBe('derived');
  });
});

describe('isTopicShape', () => {
  it('requires exactly one tag', () => {
    expect(isTopicShape({ topic: 'calculus', conceptsTaught: ['calculus', 'limits'] })).toBe(false);
    expect(isTopicShape({ topic: 'calculus', conceptsTaught: ['calculus'] })).toBe(true);
  });
});
