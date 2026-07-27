// Topic filing T4b — the quorum seed/mint decision matrix.
//
// Three properties carry the block: the bar is MIN_VOUCHABLE_POOL and nothing else, a row
// votes in exactly one cohort, and a refile leaves the vacated topic behind. The last one
// is invisible here — it is a property of `setPrimaryTopic`, asserted in the integration
// test — so what this file pins is the corollary: `decideRefile` writes NO secondary, and
// anything that starts writing one is a regression against a shipped behaviour.

import { describe, it, expect, vi } from 'vitest';

// Pure module, but the import graph reaches @/lib/db through topic-knn (which also
// exports the DB reads). Stub the leaf so the unit project stays secret-free.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  selectQuorumSlate,
  decideRefile,
  decideSettlement,
  QUORUM,
  type RefileRecord,
} from './quorum-refile';
import { MIN_VOUCHABLE_POOL } from './topic-knn';

function record(over: Partial<RefileRecord> = {}): RefileRecord {
  return {
    id: 'r1',
    title: 'Worked example: Evaluating functions from equation',
    currentTopic: 'discrete-mathematics',
    relevance: 0.9,
    unvouchable: null,
    newTopic: null,
    ...over,
  };
}

// `n` rows all voting for the same label through the same channel.
function cohort(channel: 'seed' | 'mint', label: string, n: number): RefileRecord[] {
  return [...Array(n)].map((_, i) =>
    record({ id: `r${i}`, [channel === 'seed' ? 'unvouchable' : 'newTopic']: label }),
  );
}

describe('QUORUM', () => {
  it('IS MIN_VOUCHABLE_POOL, not a second literal', () => {
    // The whole argument for the bar is that below it k-NN can never vouch for the shelf.
    // A quorum that drifted off that constant would be arbitrary — and T4e re-tuning k
    // has to move this with it.
    expect(QUORUM).toBe(MIN_VOUCHABLE_POOL);
  });
});

describe('selectQuorumSlate', () => {
  it('splits cohorts on the bar', () => {
    const slate = selectQuorumSlate([
      ...cohort('seed', 'statistics', QUORUM),
      ...cohort('mint', 'quantum-computing', QUORUM - 1),
    ]);
    expect(slate.clears.map((c) => c.label)).toEqual(['statistics']);
    expect(slate.below.map((c) => c.label)).toEqual(['quantum-computing']);
  });

  it('admits a cohort sitting exactly ON the bar', () => {
    // At exactly MIN_VOUCHABLE_POOL the refiled shelf can hold a plurality, so the move
    // is self-justifying. Off by one here and the largest cohorts would still land while
    // the marginal ones — the ones the deadlock actually traps — silently would not.
    const slate = selectQuorumSlate(cohort('seed', 'eigenvalues-and-eigenvectors', QUORUM));
    expect(slate.clears).toHaveLength(1);
    expect(slate.below).toHaveLength(0);
  });

  it('pools two spellings of one label rather than letting each miss the bar alone', () => {
    const slate = selectQuorumSlate([
      ...cohort('seed', 'Statistics', 5),
      ...cohort('seed', ' statistics ', 5),
    ]);
    expect(slate.clears).toHaveLength(1);
    expect(slate.clears[0]).toMatchObject({ label: 'statistics', channel: 'seed' });
    expect(slate.clears[0].rows).toHaveLength(10);
  });

  it('keeps the channels separate even under one label', () => {
    // A label can legitimately be both — an existing canonical for some rows and a
    // model-proposed slug for others — and only the mint side needs the gate.
    const slate = selectQuorumSlate([
      ...cohort('seed', 'number-theory', QUORUM),
      ...cohort('mint', 'number-theory', QUORUM),
    ]);
    expect(slate.clears.map((c) => c.channel).sort()).toEqual(['mint', 'seed']);
  });

  it('counts a row carrying BOTH signals toward its seed label only', () => {
    // Evidence beats a mint (T3's rule). A row voting in two cohorts could also push a
    // mint label over the bar on strength it does not exclusively have.
    const rows = cohort('seed', 'multivariable-calculus', QUORUM).map((r) => ({
      ...r,
      newTopic: 'calculus-of-variations',
    }));
    const slate = selectQuorumSlate(rows);
    expect([...slate.clears, ...slate.below].map((c) => c.label)).toEqual([
      'multivariable-calculus',
    ]);
  });

  it('ignores rows with neither signal', () => {
    expect(selectQuorumSlate([record(), record()])).toEqual({ clears: [], below: [] });
  });

  it('orders cohorts largest first', () => {
    const slate = selectQuorumSlate([
      ...cohort('seed', 'precalculus', QUORUM + 5),
      ...cohort('seed', 'statistics', QUORUM + 50),
    ]);
    expect(slate.clears.map((c) => c.label)).toEqual(['statistics', 'precalculus']);
  });
});

describe('decideRefile', () => {
  it('moves the primary to the target, contested', () => {
    const d = decideRefile(record(), 'precalculus');
    expect(d).toMatchObject({
      primary: { topic: 'precalculus', origin: 'classifier', contested: true },
    });
  });

  it('writes relevance 0 — nothing can vouch for the shelf before the cohort lands', () => {
    // Purity against an empty shelf is 0 by construction. The settle phase replaces it.
    expect(decideRefile(record(), 'precalculus')).toMatchObject({ primary: { relevance: 0 } });
  });

  it('writes NO secondary — the vacated topic is retained by setPrimaryTopic, not rewritten', () => {
    // Adding one here would either duplicate the membership that already exists or
    // overwrite T4a's measured relevance on it with a guess. That retained, UNCONTESTED
    // secondary is what keeps the vacated shelf's live Paths whole and what satisfies
    // T4d's precondition.
    expect(decideRefile(record(), 'precalculus')).toMatchObject({ secondaries: [] });
  });

  it('skips a row already filed under the target', () => {
    expect(decideRefile(record({ currentTopic: 'precalculus' }), 'precalculus')).toBe(
      'already-filed',
    );
  });
});

describe('decideSettlement', () => {
  it('vouches when the refiled topic now holds the plurality', () => {
    // The block's central claim: after the cohort moves, the shelf clears the bar it
    // could not clear before.
    expect(
      decideSettlement('statistics', { purity: 0.7, plurality: 'statistics' }, 10),
    ).toEqual({ relevance: 0.7, contested: false });
  });

  it('keeps the doubt when some other topic still holds the neighbourhood', () => {
    // The expected outcome for the thin cohorts: a 14-row topic embedded inside a 200-row
    // adjacent one cannot hold a plurality in a 10-neighbour window (As-built T4a item 7).
    expect(
      decideSettlement(
        'eigenvalues-and-eigenvectors',
        { purity: 0.3, plurality: 'linear-algebra' },
        10,
      ),
    ).toEqual({ relevance: 0.3, contested: true });
  });

  it('treats a TIE as unsettled, not as a win', () => {
    expect(decideSettlement('statistics', { purity: 0.5, plurality: null }, 10)).toMatchObject({
      contested: true,
    });
  });

  it('leaves the doubt in place when there are no neighbours to read', () => {
    expect(decideSettlement('statistics', { purity: 0, plurality: null }, 0)).toEqual({
      relevance: 0,
      contested: true,
    });
  });
});
