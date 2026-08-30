// Library-quality Q1 — concept provenance and the retry/bisect recovery.
//
// The defect these cover (P1): one poisoned item used to fail a whole 25-item
// batch, and all 25 children then silently inherited their parent's concept
// array as if it had been derived. Both halves are tested here — that bisecting
// recovers the other 24, and that whatever still fails is STAMPED.

import { describe, it, expect, vi } from 'vitest';

// concepts.ts imports @/lib/db and @/lib/ai/models, which validate env at
// module-eval. findMany is captured so the vocab query's filter is assertable.
const findMany = vi.fn();
vi.mock('@/lib/db', () => ({ prisma: { resource: { findMany: (...a: unknown[]) => findMany(...a) } } }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

import { deriveWithBisect, bisectBudgetFor, resolveConcepts, loadTopicVocab } from './concepts';
import type { DerivableItem, DerivedConcepts } from './concepts';

const ctx = { topic: 'linear-algebra' };

function items(n: number): DerivableItem[] {
  return Array.from({ length: n }, (_, i) => ({
    ref: `r${i}`,
    title: `Item ${i}`,
    description: '',
  }));
}

function tagged(batch: DerivableItem[]): Map<string, DerivedConcepts> {
  return new Map(batch.map((it) => [it.ref, { prerequisiteConcepts: [], conceptsTaught: [it.ref] }]));
}

// A model stand-in that throws for any batch containing `poison` — the shape of
// a malformed item breaking the whole structured-output parse.
function poisonedRunner(poison: string) {
  const calls: string[][] = [];
  const run = async (batch: DerivableItem[]) => {
    calls.push(batch.map((it) => it.ref));
    if (batch.some((it) => it.ref === poison)) throw new Error('could not parse object');
    return tagged(batch);
  };
  return { run, calls };
}

describe('deriveWithBisect', () => {
  it('does not retry or split a batch that succeeds', async () => {
    const { run, calls } = poisonedRunner('none');
    const out = await deriveWithBisect(items(25), run, ctx);
    expect(calls).toHaveLength(1);
    expect(out.size).toBe(25);
  });

  it('retries a failed batch once before splitting it', async () => {
    let failures = 0;
    const calls: number[] = [];
    const run = async (batch: DerivableItem[]) => {
      calls.push(batch.length);
      if (failures++ < 1) throw new Error('transient 503');
      return tagged(batch);
    };
    const out = await deriveWithBisect(items(25), run, ctx);
    // Two calls at full size — the retry succeeded, so no bisection happened.
    expect(calls).toEqual([25, 25]);
    expect(out.size).toBe(25);
  });

  it('recovers the other 24 items when one of 25 is poisoned', async () => {
    const { run, calls } = poisonedRunner('r7');
    const out = await deriveWithBisect(items(25), run, ctx);

    expect(out.size).toBe(24);
    expect(out.has('r7')).toBe(false);
    for (const it of items(25)) {
      if (it.ref !== 'r7') expect(out.get(it.ref)?.conceptsTaught).toEqual([it.ref]);
    }
    // Every failing node is attempted twice before it splits, and bisection
    // isolates a single poisoned item in log2(25) ≈ 5 levels — nowhere near the
    // 2n calls a naive per-item retry would cost.
    expect(calls.length).toBeLessThan(25);
    expect(calls.some((refs) => refs.length === 1 && refs[0] === 'r7')).toBe(true);
  });

  it('splits on the ceiling so an odd batch never recurses on the same length', async () => {
    const { run, calls } = poisonedRunner('r0');
    await deriveWithBisect(items(3), run, ctx);
    // 3 → [r0,r1] + [r2]; the failing half must be smaller than its parent or
    // the recursion never terminates.
    expect(calls).toContainEqual(['r0', 'r1']);
    expect(calls).toContainEqual(['r2']);
  });

  it('gives up on a single item after two attempts, mapping nothing for it', async () => {
    const { run, calls } = poisonedRunner('r0');
    const out = await deriveWithBisect(items(1), run, ctx);
    expect(calls).toEqual([['r0'], ['r0']]);
    expect(out.size).toBe(0);
  });

  it('maps nothing and calls nothing for an empty batch', async () => {
    const { run, calls } = poisonedRunner('none');
    expect((await deriveWithBisect([], run, ctx)).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// The 2026-08-30 multivariable-calculus regression: the model failed the schema
// for EVERY subset, so bisection's one-poison-item premise was false and the tree
// collapsed 25 → 13/12 → 7/6 → 3/3 → 1, paying ~98 calls to recover nothing.
describe('deriveWithBisect call budget', () => {
  // Everything fails — the shape that made the recursion pathological.
  function alwaysFails() {
    const calls: number[] = [];
    const run = async (batch: DerivableItem[]) => {
      calls.push(batch.length);
      throw new Error('No object generated: response did not match schema.');
    };
    return { run, calls };
  }

  it('caps a total collapse well below the unbudgeted cost', async () => {
    const { run, calls } = alwaysFails();
    const out = await deriveWithBisect(items(25), run, ctx);

    expect(out.size).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(bisectBudgetFor(25));
    // The unbudgeted tree was 2 attempts over 2n-1 nodes.
    expect(calls.length).toBeLessThan(2 * (2 * 25 - 1));
  });

  it('leaves the single-poison recovery intact — the budget never costs an item', async () => {
    // Poison at index 0 is the most expensive placement (17 calls for n=25),
    // so if any single-poison batch fits the budget, this one does.
    const { run, calls } = poisonedRunner('r0');
    const out = await deriveWithBisect(items(25), run, ctx);

    expect(out.size).toBe(24);
    expect(calls.length).toBeLessThan(bisectBudgetFor(25));
  });

  it('recovers two poisoned items without exhausting the budget', async () => {
    const calls: string[][] = [];
    const run = async (batch: DerivableItem[]) => {
      calls.push(batch.map((it) => it.ref));
      if (batch.some((it) => it.ref === 'r0' || it.ref === 'r24')) throw new Error('bad');
      return tagged(batch);
    };
    const out = await deriveWithBisect(items(25), run, ctx);

    expect(out.size).toBe(23);
    expect(out.has('r0')).toBe(false);
    expect(out.has('r24')).toBe(false);
  });

  it('budget floor is the measured single-poison cost, not a guess', () => {
    // 3*ceil(log2 n) + 2 is the exact worst-case single-poison cost; the budget
    // must sit at or above it or the heuristic loses items it could recover.
    for (const n of [2, 3, 7, 12, 25, 50]) {
      expect(bisectBudgetFor(n)).toBeGreaterThanOrEqual(3 * Math.ceil(Math.log2(n)) + 2);
    }
  });

  it('stops calling once the budget is spent', async () => {
    const { run, calls } = alwaysFails();
    await deriveWithBisect(items(25), run, ctx, { remaining: 5 });
    expect(calls).toHaveLength(5);
  });

  it('does not call at all when handed a spent budget', async () => {
    const { run, calls } = alwaysFails();
    const out = await deriveWithBisect(items(25), run, ctx, { remaining: 0 });
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it('shares one budget across both halves rather than one per subtree', async () => {
    // Concurrent halves would both read the same `remaining` before either
    // decremented, funding an extra level of the tree past the cap.
    const { run, calls } = alwaysFails();
    await deriveWithBisect(items(25), run, ctx, { remaining: 7 });
    expect(calls).toHaveLength(7);
  });
});

describe('resolveConcepts', () => {
  const parentConcepts = ['matrices', 'eigenvalues'];

  it('stamps derived when the deriver returned tags', () => {
    expect(
      resolveConcepts({
        derived: { prerequisiteConcepts: ['vectors'], conceptsTaught: ['determinants'] },
        parentConcepts,
        topic: 'linear-algebra',
      }),
    ).toEqual({
      prerequisiteConcepts: ['vectors'],
      conceptsTaught: ['determinants'],
      conceptOrigin: 'derived',
    });
  });

  it('stamps inherited — never derived — when derivation produced nothing', () => {
    const resolved = resolveConcepts({ derived: undefined, parentConcepts, topic: 'linear-algebra' });
    expect(resolved).toEqual({
      prerequisiteConcepts: [],
      conceptsTaught: parentConcepts,
      conceptOrigin: 'inherited',
    });
  });

  it('stamps fallback, distinguishably, for the [topic] last resort', () => {
    expect(
      resolveConcepts({ derived: undefined, parentConcepts: [], topic: 'linear-algebra' }),
    ).toEqual({
      prerequisiteConcepts: [],
      conceptsTaught: ['linear-algebra'],
      conceptOrigin: 'fallback',
    });
  });
});

describe('loadTopicVocab', () => {
  it('grounds only on derived rows, so a failed derivation cannot seed the vocabulary', async () => {
    findMany.mockResolvedValueOnce([
      { conceptsTaught: ['determinants'], prerequisiteConcepts: ['vectors'] },
      { conceptsTaught: ['determinants'], prerequisiteConcepts: [] },
    ]);

    const vocab = await loadTopicVocab('linear-algebra');

    expect(vocab).toEqual(['determinants', 'vectors']);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ topic: 'linear-algebra', conceptOrigin: 'derived' }),
      }),
    );
  });
});
