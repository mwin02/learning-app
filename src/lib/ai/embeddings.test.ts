import { describe, it, expect, vi, beforeEach } from 'vitest';

const embedMany = vi.fn();

vi.mock('ai', () => ({ embedMany: (...args: unknown[]) => embedMany(...args) }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/models', () => ({
  getEmbeddingModel: () => ({ model: {}, modelId: 'text-embedding-005', dimensions: 768 }),
}));

const { embedTexts } = await import('@/lib/ai/embeddings');

const DIMS = 768;

// Each vector encodes the index of its own text, so an out-of-order or dropped
// chunk is caught rather than just a wrong total.
function vecFor(i: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = i;
  return v;
}

beforeEach(() => {
  embedMany.mockReset();
  let next = 0;
  embedMany.mockImplementation(async ({ values }: { values: string[] }) => {
    const embeddings = values.map(() => vecFor(next++));
    return { embeddings };
  });
});

describe('embedTexts chunking', () => {
  // The 2026-08-30 multivariable-calculus build: a 268-child doc-TOC
  // decomposition sent all 268 in one predict call and Vertex rejected the
  // request ("250 instance(s) is allowed per prediction"), so safeEmbedBatch
  // logged and returned all-nulls for the whole batch.
  it('splits a 268-text batch below the 250-instance predict limit', async () => {
    const out = await embedTexts(Array.from({ length: 268 }, (_, i) => `t${i}`));

    expect(embedMany).toHaveBeenCalledTimes(2);
    expect(embedMany.mock.calls[0][0].values).toHaveLength(250);
    expect(embedMany.mock.calls[1][0].values).toHaveLength(18);
    expect(out).toHaveLength(268);
  });

  it('never exceeds the limit on a much larger batch', async () => {
    await embedTexts(Array.from({ length: 1200 }, (_, i) => `t${i}`));

    expect(embedMany).toHaveBeenCalledTimes(5);
    for (const [{ values }] of embedMany.mock.calls) {
      expect(values.length).toBeLessThanOrEqual(250);
    }
  });

  it('preserves order across chunk boundaries', async () => {
    const out = await embedTexts(Array.from({ length: 268 }, (_, i) => `t${i}`));

    expect(out.map((v) => v[0])).toEqual(Array.from({ length: 268 }, (_, i) => i));
  });

  it('sends one call for a batch at the limit, and none for an empty batch', async () => {
    await embedTexts(Array.from({ length: 250 }, (_, i) => `t${i}`));
    expect(embedMany).toHaveBeenCalledTimes(1);

    embedMany.mockClear();
    expect(await embedTexts([])).toEqual([]);
    expect(embedMany).not.toHaveBeenCalled();
  });

  it('still rejects a dimension mismatch', async () => {
    embedMany.mockImplementation(async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => new Array<number>(512).fill(0)),
    }));

    await expect(embedTexts(['a'])).rejects.toThrow(/dimension mismatch/i);
  });
});
