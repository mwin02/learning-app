// Unit tests for the T2b filing decision matrix. `decideFiling` is pure, so every branch
// of the guardrail is exercised here without a DB, an LLM or an embedding — the DB reads
// it consumes (knnNeighbourTopics / topicPools) are covered by the integration test.
import { describe, it, expect, vi } from 'vitest';
import {
  decideFiling,
  decideMintedFiling,
  decideCollision,
  KNN_K,
  MAX_MEMBERSHIPS,
  MIN_SECONDARY_PURITY,
  MIN_VOUCHABLE_POOL,
} from './topic-knn';

// topic-knn imports the prisma client for its query helpers, which validates
// DATABASE_URL at module eval; the function under test never touches it.
vi.mock('@/lib/db', () => ({ prisma: {} }));

// A neighbourhood of exactly KNN_K labels built from a {topic: count} spec.
function neighbours(spec: Record<string, number>): string[] {
  const out = Object.entries(spec).flatMap(([topic, n]) => Array(n).fill(topic) as string[]);
  if (out.length !== KNN_K) throw new Error(`spec must total ${KNN_K}, got ${out.length}`);
  return out;
}

// Every topic below is vouchable unless a test says otherwise.
const POOLS = new Map([
  ['calculus', 400],
  ['precalculus', 50],
  ['linear-algebra', 200],
  ['sql', 90],
  ['python', 60],
]);

describe('decideFiling — the proposal is accepted', () => {
  it('files under the classifier proposal when it holds the plurality', () => {
    const d = decideFiling({
      proposals: ['calculus'],
      requestTopic: 'linear-algebra',
      neighbourTopics: neighbours({ calculus: 6, 'linear-algebra': 3, sql: 1 }),
      pools: POOLS,
    });
    expect(d.reason).toBe('classifier');
    expect(d.primary).toMatchObject({ topic: 'calculus', origin: 'classifier', contested: false });
    expect(d.primary.relevance).toBeCloseTo(0.6);
  });

  it('adds a secondary for a further proposal that holds its own share', () => {
    const d = decideFiling({
      proposals: ['calculus', 'precalculus'],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 6, precalculus: 3, sql: 1 }),
      pools: POOLS,
    });
    expect(d.secondaries).toHaveLength(1);
    expect(d.secondaries[0]).toMatchObject({ topic: 'precalculus', origin: 'classifier', contested: false });
    expect(d.secondaries[0].relevance).toBeCloseTo(0.3);
  });

  it('drops a proposal the neighbourhood does not support', () => {
    const d = decideFiling({
      proposals: ['calculus', 'sql'],
      requestTopic: 'calculus',
      // sql holds 1/10 = 0.1, under MIN_SECONDARY_PURITY.
      neighbourTopics: neighbours({ calculus: 6, precalculus: 3, sql: 1 }),
      pools: POOLS,
    });
    expect(MIN_SECONDARY_PURITY).toBeGreaterThan(0.1);
    expect(d.secondaries).toEqual([]);
  });

  it('keeps the request topic as a secondary when the evidence supports it', () => {
    // The run that paid to discover this row must still be able to retrieve it.
    const d = decideFiling({
      proposals: ['calculus'],
      requestTopic: 'precalculus',
      neighbourTopics: neighbours({ calculus: 6, precalculus: 3, sql: 1 }),
      pools: POOLS,
    });
    expect(d.primary.topic).toBe('calculus');
    expect(d.secondaries.map((s) => s.topic)).toEqual(['precalculus']);
  });

  it('does not keep the request topic when the evidence does not support it', () => {
    const d = decideFiling({
      proposals: ['calculus'],
      requestTopic: 'python',
      neighbourTopics: neighbours({ calculus: 9, sql: 1 }),
      pools: POOLS,
    });
    expect(d.secondaries).toEqual([]);
  });

  it('never repeats the primary as a secondary', () => {
    const d = decideFiling({
      proposals: ['calculus', 'calculus'],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 8, sql: 2 }),
      pools: POOLS,
    });
    expect(d.secondaries).toEqual([]);
  });

  // A thin shelf can hold 2 of 10 neighbours, so purity alone would hand it an
  // UNCONTESTED secondary — retrievable under T1's predicate — while the identical topic
  // as a PRIMARY would be flagged `unvouchable-pool`. Same bar on both sides.
  it('flags a secondary whose shelf is too thin for k-NN to vouch for', () => {
    const d = decideFiling({
      proposals: ['calculus', 'statistics'],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 6, statistics: 3, sql: 1 }),
      pools: new Map([...POOLS, ['statistics', MIN_VOUCHABLE_POOL - 1]]),
    });
    expect(d.reason).toBe('classifier');
    expect(d.secondaries).toHaveLength(1);
    expect(d.secondaries[0]).toMatchObject({ topic: 'statistics', contested: true });
    // Recorded, not dropped: the review drain is what promotes it.
    expect(d.secondaries[0].relevance).toBeCloseTo(0.3);
  });

  // The cap (MAX_MEMBERSHIPS - 1 secondaries) is applied after this sort, so ordering is
  // what decides which membership survives: a hypothesis nothing can vouch for must never
  // displace one that would be retrievable, however well it scores.
  it('ranks vouched secondaries ahead of unvouchable ones regardless of purity', () => {
    const d = decideFiling({
      proposals: ['calculus', 'statistics', 'precalculus'],
      requestTopic: 'calculus',
      // statistics out-scores precalculus on purity, but nothing can vouch for it.
      neighbourTopics: neighbours({ calculus: 5, statistics: 3, precalculus: 2 }),
      pools: new Map([...POOLS, ['statistics', MIN_VOUCHABLE_POOL - 1]]),
    });
    expect(d.secondaries.map((s) => s.topic)).toEqual(['precalculus', 'statistics']);
    expect(d.secondaries.map((s) => s.contested)).toEqual([false, true]);
  });

  it('caps total memberships and keeps the strongest secondaries', () => {
    const d = decideFiling({
      proposals: ['calculus', 'sql', 'precalculus'],
      requestTopic: 'linear-algebra',
      neighbourTopics: neighbours({ calculus: 4, precalculus: 3, sql: 2, 'linear-algebra': 1 }),
      pools: POOLS,
    });
    expect(1 + d.secondaries.length).toBeLessThanOrEqual(MAX_MEMBERSHIPS);
    // Ordered by measured purity, not by the classifier's ranking.
    expect(d.secondaries.map((s) => s.topic)).toEqual(['precalculus', 'sql']);
  });
});

describe('decideFiling — the guardrail cannot vouch', () => {
  it('accepts a proposal for a topic with too small a pool, flagged contested', () => {
    // 10 of the 20 canonicals had NO pool on 2026-07-25. Rejecting these would make half
    // the vocabulary permanently unfilable and deadlock the self-widening property.
    const d = decideFiling({
      proposals: ['statistics'],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 9, sql: 1 }),
      pools: new Map([...POOLS, ['statistics', MIN_VOUCHABLE_POOL - 1]]),
    });
    expect(d.reason).toBe('unvouchable-pool');
    expect(d.primary).toMatchObject({ topic: 'statistics', origin: 'classifier', contested: true });
    expect(d.secondaries).toEqual([]);
  });

  it('treats an entirely unknown topic as unvouchable rather than rejecting it', () => {
    const d = decideFiling({
      proposals: ['physics-mechanics'],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 10 }),
      pools: POOLS,
    });
    expect(d.reason).toBe('unvouchable-pool');
    expect(d.primary.topic).toBe('physics-mechanics');
  });
});

describe('decideFiling — the proposal is rejected', () => {
  it('falls back to the request topic without auto-refiling to the plurality', () => {
    // Detection works, correction does not (the Khan "Functions" case): the neighbours
    // say calculus, but that is not evidence the row BELONGS to calculus.
    const d = decideFiling({
      proposals: ['linear-algebra'],
      requestTopic: 'sql',
      neighbourTopics: neighbours({ calculus: 7, 'linear-algebra': 3 }),
      pools: POOLS,
    });
    expect(d.reason).toBe('rejected');
    expect(d.primary).toMatchObject({ topic: 'sql', origin: 'discovery', contested: true });
    expect(d.secondaries).toEqual([]);
  });

  it('does not flag the fallback when the request topic is itself what the neighbours say', () => {
    const d = decideFiling({
      proposals: ['linear-algebra'],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 7, 'linear-algebra': 3 }),
      pools: POOLS,
    });
    expect(d.primary).toMatchObject({ topic: 'calculus', contested: false });
    expect(d.primary.relevance).toBeCloseTo(0.7);
  });

  it('treats a tie as no verdict, flagging even the request topic', () => {
    // A split neighbourhood is ambiguous evidence, not weak agreement — so the doubt is
    // recorded even though the row still lands on the topic that discovered it.
    const d = decideFiling({
      proposals: ['calculus'],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 5, 'linear-algebra': 5 }),
      pools: POOLS,
    });
    expect(d.reason).toBe('rejected');
    expect(d.primary).toMatchObject({ topic: 'calculus', contested: true });
  });
});

describe('decideMintedFiling — T3', () => {
  const evidence = {
    proposals: [],
    requestTopic: 'calculus',
    neighbourTopics: neighbours({ calculus: 4, 'linear-algebra': 3, sql: 3 }),
    pools: POOLS,
  };

  it('files under the minted topic, always contested', () => {
    // A freshly minted topic has no pool, so k-NN cannot vouch for it by construction —
    // the flag is honest, and a contested PRIMARY stays retrievable so the pool can fill.
    const d = decideMintedFiling(evidence, 'algebra');
    expect(d.reason).toBe('minted');
    expect(d.primary).toMatchObject({ topic: 'algebra', origin: 'classifier', contested: true });
    expect(d.primary.relevance).toBe(0);
  });

  it('keeps the request topic as a secondary when the neighbourhood supports it', () => {
    // Otherwise the run that paid for this discovery cannot retrieve its own find: a
    // minted topic is not reachable through relatedTopics widening either.
    const d = decideMintedFiling(evidence, 'algebra');
    expect(d.secondaries).toHaveLength(1);
    expect(d.secondaries[0]).toMatchObject({ topic: 'calculus', contested: false });
    expect(d.secondaries[0].relevance).toBeCloseTo(0.4);
  });

  it('drops the request topic when the neighbourhood does not support it', () => {
    const d = decideMintedFiling(
      { ...evidence, requestTopic: 'python', neighbourTopics: neighbours({ calculus: 10 }) },
      'algebra',
    );
    expect(d.secondaries).toEqual([]);
  });

  it('does not duplicate the request topic when the gate resolved onto it', () => {
    // Tier 1/2 (or T1.5's snap) can map the proposed label onto the request topic itself.
    const d = decideMintedFiling(evidence, 'calculus');
    expect(d.primary.topic).toBe('calculus');
    expect(d.secondaries).toEqual([]);
  });
});

describe('decideCollision — T3', () => {
  it('admits the rediscovering topic when it holds the plurality', () => {
    const m = decideCollision('calculus', neighbours({ calculus: 7, sql: 3 }), POOLS);
    expect(m).toMatchObject({ topic: 'calculus', origin: 'collision', contested: false });
    expect(m!.relevance).toBeCloseTo(0.7);
  });

  it('records the measured purity, never the schema default of 1.0', () => {
    // A collision row carrying 1.0 would outrank guarded classifier rows under any
    // future minRelevance — backwards, since it is the least-evidenced membership kind.
    const m = decideCollision('calculus', neighbours({ calculus: 6, sql: 4 }), POOLS);
    expect(m!.relevance).toBeCloseTo(0.6);
    expect(m!.relevance).not.toBe(1);
  });

  it('admits a topic with too small a pool, flagged contested', () => {
    const m = decideCollision('statistics', neighbours({ calculus: 10 }), POOLS);
    expect(m).toMatchObject({ topic: 'statistics', origin: 'collision', contested: true });
  });

  it('declines when the neighbourhood disagrees — no free pass for the searched topic', () => {
    // The whole point: "two topics found the same page" is a hypothesis, not evidence.
    expect(decideCollision('sql', neighbours({ calculus: 7, sql: 3 }), POOLS)).toBeNull();
  });

  it('declines on a tie', () => {
    expect(decideCollision('calculus', neighbours({ calculus: 5, sql: 5 }), POOLS)).toBeNull();
  });

  it('declines when the existing row has no embedding', () => {
    // knnNeighbourTopicsOf returns [] for an unembedded row — no evidence, no membership.
    expect(decideCollision('calculus', [], POOLS)).toBeNull();
  });

  it('declines when the library has fewer than k neighbours', () => {
    expect(decideCollision('calculus', ['calculus', 'calculus'], POOLS)).toBeNull();
  });
});

describe('decideFiling — no evidence', () => {
  it('falls back, flagged, when the classifier proposed nothing', () => {
    const d = decideFiling({
      proposals: [],
      requestTopic: 'calculus',
      neighbourTopics: neighbours({ calculus: 10 }),
      pools: POOLS,
    });
    expect(d.reason).toBe('no-evidence');
    expect(d.primary).toMatchObject({ topic: 'calculus', origin: 'discovery', contested: true });
  });

  it('falls back, flagged, when the library has fewer than k neighbours', () => {
    const d = decideFiling({
      proposals: ['calculus'],
      requestTopic: 'sql',
      neighbourTopics: ['calculus', 'calculus'],
      pools: POOLS,
    });
    expect(d.reason).toBe('no-evidence');
    expect(d.primary).toMatchObject({ topic: 'sql', contested: true });
  });

  it('falls back, flagged, when the resource has no embedding at all', () => {
    const d = decideFiling({
      proposals: ['calculus'],
      requestTopic: 'sql',
      neighbourTopics: [],
      pools: POOLS,
    });
    expect(d.reason).toBe('no-evidence');
    expect(d.primary).toMatchObject({ topic: 'sql', contested: true, relevance: 0 });
  });
});
