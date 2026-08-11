// Unit tests for Q4's parent prior (plan defect P3).
//
// The prior is two pieces: `promoteParentTopic` (a pure reordering of the classifier's
// ranked proposals) and `decideFilingWithParentPrior` (which runs the REAL `decideFiling`
// on both orderings and keeps the primed one only when it is an upgrade). The second is
// where the tests carry their weight — the reordering is trivially correct in isolation,
// and both defects found in review were composition defects, invisible to any test that
// looked at the ordering alone.
import { describe, it, expect, vi } from 'vitest';
import { promoteParentTopic, decideFilingWithParentPrior } from './classify-topic';
import { decideFiling, KNN_K, MIN_VOUCHABLE_POOL, type FilingInput } from '@/lib/curation/topic-knn';

// Both modules validate env at module eval (getModel → vertex, topic-knn → prisma); the
// functions under test touch neither.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

function neighbours(spec: Record<string, number>): string[] {
  const out = Object.entries(spec).flatMap(([topic, n]) => Array(n).fill(topic) as string[]);
  if (out.length !== KNN_K) throw new Error(`spec must total ${KNN_K}, got ${out.length}`);
  return out;
}

const POOLS = new Map([
  ['calculus', 400],
  ['linear-algebra', 200],
  ['precalculus', 50],
  ['python', 60],
  // Deliberately below the bar — the thin shelves P4 describes and Q7 will fix.
  ['graph-theory', MIN_VOUCHABLE_POOL - 2],
  ['rust', MIN_VOUCHABLE_POOL - 2],
]);

// The parent topic is the request topic for a decomposed child (see fileChildren).
function input(proposals: string[], parentTopic: string, neighbourTopics: string[]): FilingInput {
  return { proposals, requestTopic: parentTopic, neighbourTopics, pools: POOLS };
}

// THE INVARIANT, as an assertion: the prior may never change the filing except to improve
// it. Every case below runs through here, so a future edit that makes the prior fire in
// some branch nobody thought about fails the suite rather than the library.
function expectNeverWorseThanUnprimed(i: FilingInput) {
  const unprimed = decideFiling(i);
  const primed = decideFilingWithParentPrior(i);
  if (primed.reason === unprimed.reason) {
    expect(primed).toEqual(unprimed);
    return primed;
  }
  // The ONLY sanctioned divergence: an unvouched fallback became a vouched acceptance.
  expect(unprimed.reason === 'rejected' || unprimed.reason === 'no-evidence').toBe(true);
  expect(primed.reason).toBe('classifier');
  expect(primed.primary.contested).toBe(false);
  // An upgrade never moves the child between shelves — both file under the request topic.
  expect(primed.primary.topic).toBe(unprimed.primary.topic);
  return primed;
}

describe('promoteParentTopic — the reordering, in isolation', () => {
  it('promotes the parent topic to the head when the classifier hedged across shelves', () => {
    expect(promoteParentTopic(['linear-algebra', 'calculus'], 'calculus')).toEqual([
      'calculus',
      'linear-algebra',
    ]);
  });

  it('keeps the demoted proposals, in order, as secondary candidates', () => {
    expect(promoteParentTopic(['python', 'calculus', 'linear-algebra'], 'calculus')).toEqual([
      'calculus',
      'python',
      'linear-algebra',
    ]);
  });

  it('never overrides a confident single-topic classification', () => {
    expect(promoteParentTopic(['linear-algebra'], 'calculus')).toEqual(['linear-algebra']);
  });

  it('never injects a parent topic the classifier did not propose', () => {
    expect(promoteParentTopic(['linear-algebra', 'python'], 'calculus')).toEqual([
      'linear-algebra',
      'python',
    ]);
  });

  it('does not invent a filing out of an empty classification', () => {
    expect(promoteParentTopic([], 'calculus')).toEqual([]);
  });
});

describe('the prior upgrades a fallback into a vouched filing', () => {
  it('files the parent topic as a classifier membership when the evidence backs it', () => {
    const i = input(['linear-algebra', 'calculus'], 'calculus', neighbours({ calculus: 6, 'linear-algebra': 4 }));
    // Unprimed, the classifier's head loses the plurality and the whole filing degrades
    // to a mute fallback under the same topic the prior would have chosen.
    expect(decideFiling(i).reason).toBe('rejected');
    const d = expectNeverWorseThanUnprimed(i);
    expect(d.reason).toBe('classifier');
    expect(d.primary).toMatchObject({ topic: 'calculus', origin: 'classifier', contested: false });
    // The rival the classifier proposed survives as a membership instead of being dropped.
    expect(d.secondaries.map((s) => s.topic)).toContain('linear-algebra');
  });
});

describe('the prior never costs a proposal the guardrail would have accepted', () => {
  // ⚠️ REGRESSION 1. The classifier's true top pick is confirmed by a unanimous
  // neighbourhood while the parent sits behind it as a hedge. Promoting the parent here
  // demoted the correct answer out of the slot decideFiling pivots on, the plurality
  // check then failed against the parent, and the child was re-filed onto the parent's
  // topic as `rejected` — P3 reproduced by the very code meant to remove it.
  it('files the confirmed head even when the parent topic is a hedge behind it', () => {
    const i = input(['linear-algebra', 'calculus'], 'calculus', Array<string>(KNN_K).fill('linear-algebra'));
    const d = expectNeverWorseThanUnprimed(i);
    expect(d.reason).toBe('classifier');
    expect(d.primary).toMatchObject({
      topic: 'linear-algebra',
      origin: 'classifier',
      contested: false,
    });
  });

  // ⚠️ REGRESSION 2. A real but THIN shelf as the head. This never reaches decideFiling's
  // plurality check at all — MIN_VOUCHABLE_POOL accepts it as contested first — so a
  // prior that guarded itself by re-deriving the plurality test fired anyway and dragged
  // the child onto the parent's fat shelf. That flagged acceptance is the only way a thin
  // shelf ever grows (P4 / Q7), and spending it is exactly how thin shelves starve.
  it('leaves a thin-shelf head accepted-and-flagged when the neighbourhood is noise', () => {
    const i = input(['graph-theory', 'calculus'], 'calculus', neighbours({ python: 5, precalculus: 5 }));
    const d = expectNeverWorseThanUnprimed(i);
    expect(d.reason).toBe('unvouchable-pool');
    expect(d.primary).toMatchObject({ topic: 'graph-theory', origin: 'classifier', contested: true });
  });

  it('leaves a thin-shelf head alone even when the parent holds the plurality', () => {
    const i = input(['rust', 'calculus'], 'calculus', neighbours({ calculus: 7, python: 3 }));
    const d = expectNeverWorseThanUnprimed(i);
    expect(d.reason).toBe('unvouchable-pool');
    expect(d.primary.topic).toBe('rust');
  });

  // The milder path: the evidence confirms the parent, but the PARENT's shelf is thin.
  // Promotion would turn an evidence-backed `rejected` fallback into a contested
  // `unvouchable-pool` stamp — a more uncertain record of the same filing, which is not
  // an upgrade, so it is not taken.
  it('does not trade a fallback for a more uncertain stamp on the same topic', () => {
    const i = input(['python', 'graph-theory'], 'graph-theory', neighbours({ 'graph-theory': 6, python: 4 }));
    const d = expectNeverWorseThanUnprimed(i);
    expect(d.reason).toBe('rejected');
    expect(d.primary).toMatchObject({ topic: 'graph-theory', contested: false });
  });
});

describe('the prior is inert where it has nothing to break', () => {
  it('changes nothing when the classifier committed to one topic', () => {
    const i = input(['linear-algebra'], 'calculus', neighbours({ 'linear-algebra': 7, calculus: 3 }));
    expect(decideFilingWithParentPrior(i)).toEqual(decideFiling(i));
  });

  it('changes nothing when the parent topic was not proposed', () => {
    const i = input(['linear-algebra', 'python'], 'calculus', neighbours({ python: 6, 'linear-algebra': 4 }));
    expect(decideFilingWithParentPrior(i)).toEqual(decideFiling(i));
  });

  it('changes nothing when a third topic holds the neighbourhood', () => {
    const i = input(['linear-algebra', 'calculus'], 'calculus', neighbours({ python: 6, calculus: 2, 'linear-algebra': 2 }));
    const d = expectNeverWorseThanUnprimed(i);
    expect(d.reason).toBe('rejected');
    expect(d.primary.contested).toBe(true);
  });

  it('changes nothing when the parent topic is already the head', () => {
    const i = input(['calculus', 'python'], 'calculus', neighbours({ calculus: 6, python: 4 }));
    expect(decideFilingWithParentPrior(i)).toEqual(decideFiling(i));
  });
});

describe('a child the classifier cannot place is filed, not dropped', () => {
  it('falls back to the parent topic, contested, when there are no proposals', () => {
    const d = decideFilingWithParentPrior(input([], 'calculus', neighbours({ calculus: 8, python: 2 })));
    expect(d.reason).toBe('no-evidence');
    expect(d.primary.topic).toBe('calculus');
    expect(d.primary.contested).toBe(true);
    // `relevance` is the MEASURED purity, so "we don't know" is not written as 1.0.
    expect(d.primary.relevance).toBeCloseTo(0.8);
  });

  it('falls back to the parent topic when the child could not be embedded', () => {
    const d = decideFilingWithParentPrior(input(['linear-algebra', 'calculus'], 'calculus', []));
    expect(d.reason).toBe('no-evidence');
    expect(d.primary.topic).toBe('calculus');
    expect(d.primary.contested).toBe(true);
  });
});
