import { describe, it, expect } from 'vitest';
import {
  rootContainerOf,
  queuePriority,
  groupQueue,
  filingHistogram,
  type DrainRow,
  type ParentLink,
} from './review-drain';

function row(over: Partial<DrainRow> & Pick<DrainRow, 'resourceId'>): DrainRow {
  return {
    membershipId: `m-${over.resourceId}`,
    title: over.resourceId,
    topic: 'linear-algebra',
    isPrimary: true,
    relevance: 0.5,
    origin: 'classifier',
    parentId: null,
    margin: null,
    ...over,
  };
}

const parents = (entries: Array<[string, string | null]>): Map<string, ParentLink> =>
  new Map(entries.map(([id, parentId]) => [id, { parentId }]));

describe('rootContainerOf', () => {
  it('returns null for a top-level row', () => {
    expect(rootContainerOf(row({ resourceId: 'a' }), parents([]))).toBeNull();
  });

  it('walks a multi-level chain to the root container', () => {
    const byId = parents([
      ['leaf', 'unit'],
      ['unit', 'course'],
      ['course', null],
    ]);
    expect(rootContainerOf(row({ resourceId: 'leaf', parentId: 'unit' }), byId)).toBe('course');
  });

  it('stops at the highest ancestor present when the chain leaves the loaded set', () => {
    // `unit`'s own parent was never loaded, so `unit` is the best root available.
    expect(rootContainerOf(row({ resourceId: 'leaf', parentId: 'unit' }), parents([]))).toBe('unit');
  });

  it('does not hang on a cyclic parent chain', () => {
    const byId = parents([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(rootContainerOf(row({ resourceId: 'a', parentId: 'b' }), byId)).toBe('a');
  });
});

describe('queuePriority', () => {
  it('ranks a margin-bearing row by its margin, lowest first', () => {
    expect(queuePriority(row({ resourceId: 'a', margin: -0.02 }))).toEqual([0, -0.02]);
    expect(queuePriority(row({ resourceId: 'b', margin: 0.3 }))).toEqual([0, 0.3]);
  });

  // The block's load-bearing measurement: 34 of 131 contested primaries have no margin,
  // because their shelf is under MIN_CENTROID_MEMBERS. They are the six thin shelves T4e
  // flagged for triage first, so they must stay ranked among themselves rather than
  // collapsing into one undifferentiated block.
  it('falls back to measured relevance when the shelf has no centroid', () => {
    expect(queuePriority(row({ resourceId: 'a', margin: null, relevance: 0.2 }))).toEqual([1, 0.2]);
    expect(queuePriority(row({ resourceId: 'b', margin: null, relevance: 0.9 }))).toEqual([1, 0.9]);
  });

  it('keeps the two scales in separate tiers rather than interleaving them', () => {
    // A margin (difference of cosines) and a purity (fraction of k) are not comparable,
    // so every margin-bearing row precedes every fallback row regardless of magnitude.
    const withMargin = queuePriority(row({ resourceId: 'a', margin: 0.9 }));
    const withoutMargin = queuePriority(row({ resourceId: 'b', margin: null, relevance: 0.0 }));
    expect(withMargin[0]).toBeLessThan(withoutMargin[0]);
  });
});

describe('groupQueue', () => {
  it('groups a container subtree together and gives a loose row its own group', () => {
    const rows = [
      row({ resourceId: 'leaf1', parentId: 'unit', margin: 0.1 }),
      row({ resourceId: 'loose', margin: 0.2 }),
      row({ resourceId: 'leaf2', parentId: 'unit', margin: 0.3 }),
    ];
    const groups = groupQueue(rows, parents([['unit', null]]));
    expect(groups.map((g) => g.rootId)).toEqual(['unit', 'loose']);
    expect(groups[0].rows.map((r) => r.resourceId)).toEqual(['leaf1', 'leaf2']);
    expect(groups[1].rows.map((r) => r.resourceId)).toEqual(['loose']);
  });

  it('orders a group by its most urgent row, not its size', () => {
    const rows = [
      // A big group of comfortable rows must not outrank one badly-filed row.
      row({ resourceId: 'big1', parentId: 'c1', margin: 0.5 }),
      row({ resourceId: 'big2', parentId: 'c1', margin: 0.6 }),
      row({ resourceId: 'big3', parentId: 'c1', margin: 0.7 }),
      row({ resourceId: 'bad', parentId: 'c2', margin: -0.1 }),
    ];
    const groups = groupQueue(
      rows,
      parents([
        ['c1', null],
        ['c2', null],
      ]),
    );
    expect(groups.map((g) => g.rootId)).toEqual(['c2', 'c1']);
    expect(groups[0].priority).toEqual([0, -0.1]);
  });

  it('keeps thin-shelf rows ranked among themselves behind margin-bearing groups', () => {
    const rows = [
      row({ resourceId: 'thin-bad', parentId: 'c1', margin: null, relevance: 0.1 }),
      row({ resourceId: 'thin-ok', parentId: 'c1', margin: null, relevance: 0.8 }),
      row({ resourceId: 'measured', parentId: 'c2', margin: 0.9 }),
    ];
    const groups = groupQueue(
      rows,
      parents([
        ['c1', null],
        ['c2', null],
      ]),
    );
    expect(groups.map((g) => g.rootId)).toEqual(['c2', 'c1']);
    expect(groups[1].rows.map((r) => r.resourceId)).toEqual(['thin-bad', 'thin-ok']);
  });

  it('is stable across runs when priorities tie', () => {
    // A reviewer working one batch across two sessions must not see it reshuffle, so ties
    // break on id at both levels: between groups, and between rows inside a group.
    const loose = [row({ resourceId: 'b', margin: 0.5 }), row({ resourceId: 'a', margin: 0.5 })];
    expect(groupQueue(loose, parents([])).map((g) => g.rootId)).toEqual(['a', 'b']);

    const siblings = [
      row({ resourceId: 'l2', parentId: 'c1', margin: 0.5 }),
      row({ resourceId: 'l1', parentId: 'c1', margin: 0.5 }),
    ];
    expect(
      groupQueue(siblings, parents([['c1', null]]))[0].rows.map((r) => r.resourceId),
    ).toEqual(['l1', 'l2']);
  });

  it('groups nested containers under their shared root', () => {
    const rows = [
      row({ resourceId: 'l1', parentId: 'unitA', margin: 0.1 }),
      row({ resourceId: 'l2', parentId: 'unitB', margin: 0.2 }),
    ];
    const groups = groupQueue(
      rows,
      parents([
        ['unitA', 'course'],
        ['unitB', 'course'],
        ['course', null],
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].rootId).toBe('course');
  });

  it('groups a contested container together with its own contested children', () => {
    // Measured: 5 of the top-level contested rows ARE containers whose children are also
    // in the queue. The container and its subtree must present as one decision.
    const rows = [
      row({ resourceId: 'course', margin: 0.4 }),
      row({ resourceId: 'leaf', parentId: 'course', margin: 0.2 }),
    ];
    const groups = groupQueue(rows, parents([['course', null]]));
    expect(groups).toHaveLength(1);
    expect(groups[0].rootId).toBe('course');
    expect(groups[0].rows.map((r) => r.resourceId)).toEqual(['leaf', 'course']);
  });
});

describe('filingHistogram', () => {
  it('counts sibling filings, most common first', () => {
    expect(filingHistogram(['linear-algebra', 'calculus', 'linear-algebra'])).toEqual([
      { topic: 'linear-algebra', n: 2 },
      { topic: 'calculus', n: 1 },
    ]);
  });

  it('breaks count ties alphabetically so the report is stable', () => {
    expect(filingHistogram(['b', 'a'])).toEqual([
      { topic: 'a', n: 1 },
      { topic: 'b', n: 1 },
    ]);
  });

  it('returns nothing for a container with no other children', () => {
    expect(filingHistogram([])).toEqual([]);
  });
});
