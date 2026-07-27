// Topic filing T4a — the reclassification decision matrix.
//
// The property under test in nearly every case is the one that shapes the module: the
// primary NEVER moves, whatever the evidence says. Everything else is about what doubt
// gets recorded and where.

import { describe, it, expect, vi } from 'vitest';

// Pure module, but the import graph reaches @/lib/db through topic-knn (which also
// exports the DB reads). Stub the leaf so the unit project stays secret-free.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  decideReclassification,
  tallyQuorumChannels,
  type ReclassifyInput,
  type ReclassifyDecision,
} from './reclassify';
import { KNN_K, MIN_SECONDARY_PURITY } from './topic-knn';

// A pool large enough for every topic named in these tests to be vouchable.
const POOLS = new Map([
  ['linear-algebra', 200],
  ['probability-and-statistics', 400],
  ['calculus', 380],
  ['python', 60],
  ['thin-topic', 3],
]);

// k neighbours, `hits` of them labelled `topic`, the rest labelled `filler`.
function neighbours(topic: string, hits: number, filler = 'calculus'): string[] {
  return [...Array(KNN_K)].map((_, i) => (i < hits ? topic : filler));
}

function input(over: Partial<ReclassifyInput> = {}): ReclassifyInput {
  return {
    currentTopic: 'linear-algebra',
    proposals: ['linear-algebra'],
    newTopic: null,
    neighbourTopics: neighbours('linear-algebra', 10),
    pools: POOLS,
    existingTopics: ['linear-algebra'],
    margin: 0.08,
    ...over,
  };
}

describe('decideReclassification — agreement', () => {
  it('re-scores the primary from the placeholder to measured purity', () => {
    const d = decideReclassification(input({ neighbourTopics: neighbours('linear-algebra', 8) }));
    expect(d.verdict).toBe('agree');
    expect(d.primary).toMatchObject({ topic: 'linear-algebra', relevance: 0.8, contested: false });
  });

  it('flips origin off `inherited` so the measured value is gateable', () => {
    // The origin-aware minRelevance clause exempts `inherited` rows because their 1.0 is
    // a placeholder. A measured purity left under that origin would sit in the one
    // bucket the gate ignores.
    const d = decideReclassification(input());
    expect(d.primary?.origin).toBe('classifier');
  });

  it('adds a guarded secondary that independently holds the neighbourhood', () => {
    const d = decideReclassification(
      input({
        proposals: ['linear-algebra', 'probability-and-statistics'],
        neighbourTopics: [
          ...Array(7).fill('linear-algebra'),
          ...Array(3).fill('probability-and-statistics'),
        ],
      }),
    );
    expect(d.verdict).toBe('agree');
    expect(d.secondaries).toEqual([
      expect.objectContaining({
        topic: 'probability-and-statistics',
        relevance: 0.3,
        contested: false,
      }),
    ]);
  });

  it('drops a proposed secondary the neighbourhood does not back', () => {
    const d = decideReclassification(
      input({
        proposals: ['linear-algebra', 'python'],
        neighbourTopics: [...Array(9).fill('linear-algebra'), 'python'],
      }),
    );
    // 1/10 = 0.1 is under the secondary bar.
    expect(0.1).toBeLessThan(MIN_SECONDARY_PURITY);
    expect(d.secondaries).toEqual([]);
  });
});

describe('decideReclassification — disagreement never refiles', () => {
  const disagreeing = input({
    proposals: ['probability-and-statistics'],
    neighbourTopics: neighbours('probability-and-statistics', 7, 'linear-algebra'),
  });

  it('keeps the current topic as primary and flags it', () => {
    const d = decideReclassification(disagreeing);
    expect(d.verdict).toBe('disagree');
    expect(d.primary).toMatchObject({ topic: 'linear-algebra', contested: true });
  });

  it('records the alternative as a CONTESTED secondary', () => {
    // Contested secondaries are invisible to T1's retrieval predicate, so this records
    // the hypothesis for review without widening bleed.
    const d = decideReclassification(disagreeing);
    expect(d.secondaries).toEqual([
      expect.objectContaining({
        topic: 'probability-and-statistics',
        relevance: 0.7,
        contested: true,
      }),
    ]);
  });

  it('measures the primary purity honestly even when it is low', () => {
    const d = decideReclassification(disagreeing);
    expect(d.primary?.relevance).toBe(0.3);
  });

  it('treats a rejected proposal as agreement when the neighbours back the current label', () => {
    // The classifier proposed something the plurality does not support, and the
    // plurality IS the current topic — that indicts the proposal, not the row.
    const d = decideReclassification(
      input({
        proposals: ['probability-and-statistics'],
        neighbourTopics: neighbours('linear-algebra', 8, 'probability-and-statistics'),
      }),
    );
    expect(d.verdict).toBe('agree');
    expect(d.primary).toMatchObject({ contested: false });
  });

  it('treats a rejected proposal as disagreement when a THIRD topic wins', () => {
    const d = decideReclassification(
      input({
        proposals: ['python'],
        neighbourTopics: neighbours('calculus', 8, 'linear-algebra'),
      }),
    );
    expect(d.verdict).toBe('disagree');
    expect(d.primary).toMatchObject({ topic: 'linear-algebra', contested: true });
  });

  it('never returns a primary that is not the current topic, across the matrix', () => {
    const cases: Partial<ReclassifyInput>[] = [
      { proposals: ['probability-and-statistics'] },
      { proposals: ['calculus'], neighbourTopics: neighbours('calculus', 10) },
      { proposals: ['thin-topic'] },
      { proposals: ['python', 'calculus'], neighbourTopics: neighbours('calculus', 6) },
    ];
    for (const over of cases) {
      const d = decideReclassification(input(over));
      expect(d.primary?.topic ?? 'linear-algebra').toBe('linear-algebra');
    }
  });
});

describe('decideReclassification — degradation', () => {
  it('writes NOTHING when there are fewer than k neighbours', () => {
    const d = decideReclassification(input({ neighbourTopics: ['linear-algebra'] }));
    expect(d.verdict).toBe('no-evidence');
    expect(d.primary).toBeNull();
    expect(d.secondaries).toEqual([]);
  });

  it('writes nothing when the classifier proposed nothing', () => {
    const d = decideReclassification(input({ proposals: [] }));
    expect(d.verdict).toBe('no-evidence');
    expect(d.primary).toBeNull();
  });

  // ⚠️ The regression this guards: T2b reads `unvouchable-pool` as "accept the proposal,
  // contested" — correct at discovery time, where it is how a new shelf starts filling.
  // Reusing that reading here contested the CURRENT label with no evidence against it,
  // on 10–55% of rows per topic, which would have buried the real disagreements.
  describe('unvouchable-pool is a vocabulary signal, not doubt about the row', () => {
    const unvouchable = input({ proposals: ['thin-topic'] });

    it('does NOT contest the primary', () => {
      const d = decideReclassification(unvouchable);
      expect(d.verdict).toBe('unvouchable-pool');
      expect(d.primary).toMatchObject({ topic: 'linear-algebra', contested: false });
    });

    it('writes no membership for the empty shelf', () => {
      // Its purity is 0 by construction, so a membership would record a measured-looking
      // 0.0 that actually means "we couldn't check".
      expect(decideReclassification(unvouchable).secondaries).toEqual([]);
    });

    it('routes the proposal to the seed channel instead', () => {
      expect(decideReclassification(unvouchable).unvouchable).toBe('thin-topic');
    });

    it('still re-scores the primary against the neighbourhood', () => {
      expect(decideReclassification(unvouchable).primary?.relevance).toBe(1);
    });
  });
});

describe('decideReclassification — review diagnostics', () => {
  it('reports the neighbourhood plurality when a third topic wins', () => {
    // The rejected-proposal case reports no alternative membership, so this is the only
    // thing that tells a reviewer what the evidence actually said.
    const d = decideReclassification(
      input({ proposals: ['python'], neighbourTopics: neighbours('calculus', 8, 'linear-algebra') }),
    );
    expect(d.verdict).toBe('disagree');
    expect(d.secondaries).toEqual([]);
    expect(d).toMatchObject({ evidenceTopic: 'calculus', evidencePurity: 0.8 });
  });

  it('reports no plurality on a tie', () => {
    const d = decideReclassification(
      input({ neighbourTopics: [...Array(5).fill('linear-algebra'), ...Array(5).fill('calculus')] }),
    );
    expect(d.evidenceTopic).toBeNull();
    expect(d.evidencePurity).toBe(0);
  });
});

describe('decideReclassification — idempotency and the cap', () => {
  it('proposes no secondary for a topic the row already belongs to', () => {
    const d = decideReclassification(
      input({
        proposals: ['linear-algebra', 'probability-and-statistics'],
        neighbourTopics: [
          ...Array(7).fill('linear-algebra'),
          ...Array(3).fill('probability-and-statistics'),
        ],
        existingTopics: ['linear-algebra', 'probability-and-statistics'],
      }),
    );
    expect(d.secondaries).toEqual([]);
  });

  it('respects the per-resource membership cap, counting existing memberships', () => {
    const d = decideReclassification(
      input({
        proposals: ['linear-algebra', 'probability-and-statistics'],
        neighbourTopics: [
          ...Array(7).fill('linear-algebra'),
          ...Array(3).fill('probability-and-statistics'),
        ],
        existingTopics: ['linear-algebra', 'python'],
      }),
    );
    // Cap is 3: current + python already fill two, leaving room for exactly one.
    expect(d.secondaries).toHaveLength(1);
  });

  it('writes no secondary at all once the cap is already full', () => {
    const d = decideReclassification(
      input({
        proposals: ['linear-algebra', 'probability-and-statistics'],
        neighbourTopics: [
          ...Array(7).fill('linear-algebra'),
          ...Array(3).fill('probability-and-statistics'),
        ],
        existingTopics: ['linear-algebra', 'python', 'calculus'],
      }),
    );
    expect(d.secondaries).toEqual([]);
    // The primary is still re-scored — the cap bounds new memberships, not re-scoring.
    expect(d.primary).not.toBeNull();
  });
});

describe('decideReclassification — carried signals', () => {
  it('passes newTopic and margin through untouched for T4b and the review report', () => {
    const d = decideReclassification(input({ newTopic: 'algebra', margin: -0.033 }));
    expect(d.newTopic).toBe('algebra');
    expect(d.margin).toBe(-0.033);
  });

  it('carries them through the no-evidence path too', () => {
    const d = decideReclassification(
      input({ proposals: [], newTopic: 'algebra', margin: -0.033 }),
    );
    expect(d.newTopic).toBe('algebra');
    expect(d.margin).toBe(-0.033);
  });
});

describe('tallyQuorumChannels', () => {
  const decision = (over: Partial<ReclassifyDecision>): ReclassifyDecision => ({
    verdict: 'agree',
    primary: null,
    secondaries: [],
    newTopic: null,
    unvouchable: null,
    evidenceTopic: null,
    evidencePurity: 0,
    margin: null,
    ...over,
  });

  it('pools votes case-insensitively and ignores rows with no proposal', () => {
    const tally = tallyQuorumChannels([
      decision({ newTopic: 'algebra' }),
      decision({ newTopic: 'Algebra' }),
      decision({ newTopic: ' algebra ' }),
      decision({}),
      decision({ newTopic: 'trigonometry' }),
    ]);
    expect(tally.mint).toEqual(
      new Map([
        ['algebra', 3],
        ['trigonometry', 1],
      ]),
    );
  });

  it('keeps the mint and seed channels separate', () => {
    // They need different handling: a mint has no slug yet, a seed has no pool yet.
    const tally = tallyQuorumChannels([
      decision({ newTopic: 'algebra' }),
      decision({ unvouchable: 'statistics' }),
      decision({ unvouchable: 'statistics' }),
    ]);
    expect(tally.mint).toEqual(new Map([['algebra', 1]]));
    expect(tally.seed).toEqual(new Map([['statistics', 2]]));
  });
});
