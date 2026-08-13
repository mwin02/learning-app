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

import { deriveWithBisect, resolveConcepts, loadTopicVocab } from './concepts';
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
