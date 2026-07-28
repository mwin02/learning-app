import { describe, it, expect } from 'vitest';
import {
  rootContainerOf,
  queuePriority,
  groupQueue,
  filingHistogram,
  planVerdicts,
  type DrainRow,
  type ParentLink,
  type Verdict,
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

describe('planVerdicts', () => {
  const queue = [
    row({ resourceId: 'r1', membershipId: 'm1', parentId: 'c1', topic: 'cryptography' }),
    row({ resourceId: 'r2', membershipId: 'm2', parentId: 'c1', topic: 'cryptography' }),
    row({ resourceId: 'r3', membershipId: 'm3', parentId: 'c1', topic: 'data-structures-algorithms' }),
    row({ resourceId: 'r4', membershipId: 'm4', topic: 'calculus' }),
  ];
  const tree = parents([['c1', null]]);
  // Every topic each resource holds — r4 sits at the 3-membership cap.
  const held = new Map([
    ['r1', ['cryptography']],
    ['r2', ['cryptography']],
    ['r3', ['data-structures-algorithms']],
    ['r4', ['calculus', 'real-analysis', 'topology']],
  ]);
  const plan = (verdicts: Verdict[]) => planVerdicts(queue, verdicts, tree, held, 3);

  it('applies a row verdict and reports the rest as unresolved', () => {
    const p = plan([{ verdict: 'confirm', membershipId: 'm1' }]);
    expect(p.errors).toEqual([]);
    expect(p.writes.map((w) => w.membershipId)).toEqual(['m1']);
    expect(p.unresolved.map((r) => r.membershipId)).toEqual(['m2', 'm3', 'm4']);
  });

  // The Khan Cryptography case: a container verdict must reach only the held topic it
  // names, never the whole subtree.
  it('scopes a container verdict to its applyTo topic', () => {
    const p = plan([{ verdict: 'confirm', containerId: 'c1', applyTo: 'cryptography' }]);
    expect(p.errors).toEqual([]);
    expect(p.writes.map((w) => w.membershipId)).toEqual(['m1', 'm2']);
    expect(p.writes.every((w) => w.viaContainer === 'c1')).toBe(true);
    // The dsa row in the same subtree is untouched and still owed a verdict.
    expect(p.unresolved.map((r) => r.membershipId)).toContain('m3');
  });

  it('rejects a container verdict with no applyTo', () => {
    const p = plan([{ verdict: 'confirm', containerId: 'c1' }]);
    expect(p.writes).toEqual([]);
    expect(p.errors[0]).toMatch(/requires applyTo/);
  });

  it('rejects a container verdict that matches nothing rather than silently passing', () => {
    const p = plan([{ verdict: 'confirm', containerId: 'c1', applyTo: 'typo-topic' }]);
    expect(p.writes).toEqual([]);
    expect(p.errors[0]).toMatch(/no contested 'typo-topic' rows/);
  });

  it('requires a destination topic for refile and add', () => {
    const p = plan([
      { verdict: 'refile', membershipId: 'm1' },
      { verdict: 'add', membershipId: 'm2' },
    ]);
    expect(p.writes).toEqual([]);
    expect(p.errors).toHaveLength(2);
  });

  it('reports a membership claimed twice instead of writing it twice', () => {
    const p = plan([
      { verdict: 'confirm', containerId: 'c1', applyTo: 'cryptography' },
      { verdict: 'refile', membershipId: 'm1', topic: 'number-theory' },
    ]);
    expect(p.writes.map((w) => w.membershipId)).toEqual(['m1', 'm2']);
    expect(p.errors[0]).toMatch(/already claimed by verdict\[0\]/);
  });

  it('rejects a refile of a primary onto the topic it already holds', () => {
    const p = plan([{ verdict: 'refile', membershipId: 'm4', topic: 'calculus' }]);
    expect(p.writes).toEqual([]);
    expect(p.errors[0]).toMatch(/already primary on 'calculus'/);
  });

  it('allows a refile of a contested SECONDARY onto its own topic — that is a promotion', () => {
    const secondary = [
      row({ resourceId: 'r5', membershipId: 'm5', topic: 'precalculus', isPrimary: false }),
    ];
    const p = planVerdicts(
      secondary,
      [{ verdict: 'refile', membershipId: 'm5', topic: 'precalculus' }],
      parents([]),
      new Map([['r5', ['algebra', 'precalculus']]]),
      3,
    );
    expect(p.errors).toEqual([]);
    expect(p.writes[0]).toMatchObject({ verdict: 'refile', targetTopic: 'precalculus' });
  });

  it('refuses an add that would breach the membership cap', () => {
    const p = plan([{ verdict: 'add', membershipId: 'm4', topic: 'precalculus' }]);
    expect(p.writes).toEqual([]);
    expect(p.errors[0]).toMatch(/membership cap \(3\/3\)/);
  });

  // 5 resources on the live queue hold two contested memberships each, so one file can
  // carry two `add` verdicts for the same resource. Against the caller's snapshot both
  // read the same starting count and both cleared a cap they jointly breached.
  it('counts planned adds against the cap, not just the starting snapshot', () => {
    const twice = [
      row({ resourceId: 'r6', membershipId: 'm6a', topic: 'calculus' }),
      row({ resourceId: 'r6', membershipId: 'm6b', topic: 'precalculus' }),
    ];
    const p = planVerdicts(
      twice,
      [
        { verdict: 'add', membershipId: 'm6a', topic: 'statistics' },
        { verdict: 'add', membershipId: 'm6b', topic: 'number-theory' },
      ],
      parents([]),
      new Map([['r6', ['calculus', 'precalculus']]]),
      3,
    );
    expect(p.writes.map((w) => w.membershipId)).toEqual(['m6a']);
    expect(p.errors[0]).toMatch(/membership cap \(3\/3\)/);
  });

  it('refuses an add of a topic the row already holds', () => {
    const p = plan([{ verdict: 'add', membershipId: 'm1', topic: 'cryptography' }]);
    expect(p.writes).toEqual([]);
    expect(p.errors[0]).toMatch(/already holds/);
  });

  it('refuses an add of a topic held by ANOTHER of the resource\'s memberships', () => {
    const one = [row({ resourceId: 'r7', membershipId: 'm7', topic: 'calculus' })];
    const p = planVerdicts(
      one,
      [{ verdict: 'add', membershipId: 'm7', topic: 'statistics' }],
      parents([]),
      new Map([['r7', ['calculus', 'statistics']]]),
      3,
    );
    expect(p.writes).toEqual([]);
    expect(p.errors[0]).toMatch(/already holds 'statistics'/);
  });

  // A refile is only cap-neutral when the target is already held or the vacated membership
  // is dropped in exchange. Retained + fresh topic nets +1, exactly like an `add` — the
  // path that used to slip past the cap.
  it('refuses a retained refile to a fresh topic when the resource is at the cap', () => {
    const p = plan([{ verdict: 'refile', membershipId: 'm4', topic: 'number-theory' }]);
    expect(p.writes).toEqual([]);
    expect(p.errors[0]).toMatch(/membership cap \(3\/3\)/);
  });

  it('allows the same refile when the vacated membership is dropped in exchange', () => {
    const p = plan([
      { verdict: 'refile', membershipId: 'm4', topic: 'number-theory', dropVacated: true },
    ]);
    expect(p.errors).toEqual([]);
    expect(p.writes[0]).toMatchObject({ membershipId: 'm4', targetTopic: 'number-theory' });
  });

  it('allows a refile at the cap onto a topic the resource already holds', () => {
    // Adopting an existing secondary as the new primary creates nothing.
    const p = plan([{ verdict: 'refile', membershipId: 'm4', topic: 'real-analysis' }]);
    expect(p.errors).toEqual([]);
    expect(p.writes[0]).toMatchObject({ membershipId: 'm4', targetTopic: 'real-analysis' });
  });

  it('counts a retained refile against a later add in the same file', () => {
    const twice = [
      row({ resourceId: 'r8', membershipId: 'm8a', topic: 'calculus' }),
      row({ resourceId: 'r8', membershipId: 'm8b', topic: 'precalculus' }),
    ];
    const p = planVerdicts(
      twice,
      [
        { verdict: 'refile', membershipId: 'm8a', topic: 'statistics', dropVacated: false },
        { verdict: 'add', membershipId: 'm8b', topic: 'number-theory' },
      ],
      parents([]),
      new Map([['r8', ['calculus', 'precalculus']]]),
      3,
    );
    expect(p.writes.map((w) => w.membershipId)).toEqual(['m8a']);
    expect(p.errors[0]).toMatch(/membership cap \(3\/3\)/);
  });

  it('separates skip from the writes so doubt is preserved, not cleared', () => {
    const p = plan([{ verdict: 'skip', membershipId: 'm1', note: 'title uninformative' }]);
    expect(p.writes).toEqual([]);
    expect(p.skipped[0]).toMatchObject({ membershipId: 'm1', note: 'title uninformative' });
  });

  // The default flips on `isPrimary` because retention means opposite things for the two
  // kinds of row: it preserves reach for a primary and GRANTS it for a secondary, which
  // would publish the row to the shelf the reviewer just rejected.
  it('retains the vacated topic by default when refiling a contested PRIMARY', () => {
    const p = plan([{ verdict: 'refile', membershipId: 'm1', topic: 'number-theory' }]);
    expect(p.writes[0].dropVacated).toBe(false);
  });

  it('drops the vacated topic by default when refiling a contested SECONDARY', () => {
    const secondary = [
      row({ resourceId: 'r5', membershipId: 'm5', topic: 'precalculus', isPrimary: false }),
    ];
    const p = planVerdicts(
      secondary,
      [{ verdict: 'refile', membershipId: 'm5', topic: 'number-theory' }],
      parents([]),
      new Map([['r5', ['algebra', 'precalculus']]]),
      3,
    );
    expect(p.errors).toEqual([]);
    expect(p.writes[0].dropVacated).toBe(true);
  });

  it('honours an explicit dropVacated against either default', () => {
    const secondary = [
      row({ resourceId: 'r5', membershipId: 'm5', topic: 'precalculus', isPrimary: false }),
    ];
    const kept = planVerdicts(
      secondary,
      [{ verdict: 'refile', membershipId: 'm5', topic: 'number-theory', dropVacated: false }],
      parents([]),
      new Map([['r5', ['algebra', 'precalculus']]]),
      3,
    );
    expect(kept.writes[0].dropVacated).toBe(false);
    const dropped = plan([
      { verdict: 'refile', membershipId: 'm1', topic: 'number-theory', dropVacated: true },
    ]);
    expect(dropped.writes[0].dropVacated).toBe(true);
  });

  it('rejects a verdict targeting both a row and a container', () => {
    const p = plan([{ verdict: 'confirm', membershipId: 'm1', containerId: 'c1', applyTo: 'x' }]);
    expect(p.errors[0]).toMatch(/exactly one of/);
  });

  it('rejects a membershipId that is not in the queue', () => {
    const p = plan([{ verdict: 'confirm', membershipId: 'nope' }]);
    expect(p.errors[0]).toMatch(/not in the queue/);
  });
});
