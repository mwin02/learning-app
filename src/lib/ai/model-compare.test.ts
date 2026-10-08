import { describe, expect, it, vi } from 'vitest';

// model-compare.ts imports the model-id constants from models.ts, whose vertex
// leaf throws at module-eval without GOOGLE_VERTEX_PROJECT.
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  vertexAnthropic: {},
  vertexGlobal: {},
}));

import { FLASH_MODEL_ID, PRO_MODEL_ID } from '@/lib/ai/models';
import {
  ARMS,
  armOverrides,
  callCost,
  checkBudget,
  EMPTY_LEDGER,
  jaccard,
  LADDER,
  latencySummary,
  ledgerSchema,
  median,
  pricePointOn,
  projectInputs,
  remainingUsd,
  totalCost,
} from '@/lib/ai/model-compare';

const million = { inputTokens: 1_000_000, outputTokens: 1_000_000, webSearchQueries: 0 };

describe('callCost', () => {
  it('prices Pro at $14 per 1M in + 1M out at both price points', () => {
    const cost = callCost({ modelId: 'gemini-3.1-pro-preview', ...million });
    expect(cost.intro).toBeCloseTo(14, 10);
    expect(cost['2027']).toBeCloseTo(14, 10);
  });

  it('prices Flash at $4.50 intro and $9.00 in 2027', () => {
    const cost = callCost({ modelId: 'gemini-3.7-flash', ...million });
    expect(cost.intro).toBeCloseTo(4.5, 10);
    expect(cost['2027']).toBeCloseTo(9, 10);
  });

  it('adds $14 per 1,000 grounding queries at every price point', () => {
    for (const modelId of ['gemini-3.1-pro-preview', 'gemini-3.7-flash']) {
      const without = callCost({ modelId, ...million });
      const withQueries = callCost({ modelId, ...million, webSearchQueries: 1000 });
      expect(withQueries.intro - without.intro).toBeCloseTo(14, 10);
      expect(withQueries['2027'] - without['2027']).toBeCloseTo(14, 10);
    }
  });

  it('does not add reasoning tokens on top of output tokens', () => {
    const record = { modelId: 'gemini-3.7-flash', ...million, reasoningTokens: 900_000 };
    expect(callCost(record).intro).toBeCloseTo(4.5, 10);
  });

  it('costs a failed attempt with no usage at zero', () => {
    expect(callCost({ modelId: 'gemini-3.7-flash', webSearchQueries: 0 })).toEqual({ intro: 0, '2027': 0 });
  });

  it('throws on an unknown model id instead of costing it at $0', () => {
    expect(() => callCost({ modelId: 'gemini-9-ultra', ...million })).toThrow(/gemini-9-ultra/);
  });

  it('prices both registry model ids', () => {
    expect(() => callCost({ modelId: PRO_MODEL_ID, ...million })).not.toThrow();
    expect(() => callCost({ modelId: FLASH_MODEL_ID, ...million })).not.toThrow();
  });

  it('sums records', () => {
    const record = { agent: 'a', durationMs: 1, outcome: 'ok' as const, webSearchQueries: 0 };
    const total = totalCost([
      { ...record, modelId: 'gemini-3.1-pro-preview', inputTokens: 500_000, outputTokens: 0 },
      { ...record, modelId: 'gemini-3.7-flash', inputTokens: 0, outputTokens: 1_000_000 },
    ]);
    expect(total.intro).toBeCloseTo(1 + 3.75, 10);
    expect(total['2027']).toBeCloseTo(1 + 7.5, 10);
  });

  it('switches to the 2027 price point on 2027-01-01 UTC', () => {
    expect(pricePointOn(new Date('2026-12-31T23:59:59Z'))).toBe('intro');
    expect(pricePointOn(new Date('2027-01-01T00:00:00Z'))).toBe('2027');
  });
});

describe('arms', () => {
  it('leaves the baseline at the registry config', () => {
    expect(armOverrides('baseline', 'trackComposer')).toEqual({ trackComposer: {} });
  });

  it('clears thinking to the model default on flash-default, and sets no timeout anywhere', () => {
    expect(ARMS['flash-default']).toEqual({ modelId: FLASH_MODEL_ID, thinkingLevel: null });
    for (const arm of Object.values(ARMS)) expect(arm).not.toHaveProperty('callTimeoutMs');
  });

  it('orders the ladder cheapest first', () => {
    expect(LADDER).toEqual(['flash-low', 'flash-default', 'pro-low']);
  });
});

describe('stats', () => {
  it('takes the middle of an odd-length list and the mean of the middle two of an even one', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
    expect(median([])).toBeNull();
  });

  it('summarizes latency', () => {
    expect(latencySummary([5, 1, 9])).toEqual({ p50: 5, max: 9 });
    expect(latencySummary([])).toEqual({ p50: null, max: null });
  });

  it('defines Jaccard of two empty sets as 1 and of disjoint sets as 0', () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
    expect(jaccard(['a', 'b', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 10);
    expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
  });
});

describe('budget', () => {
  const ledger = (discovery: number, banks: number, composer: number) =>
    ledgerSchema.parse({ spentUsd: { discovery, banks, composer } });

  it('refuses a call that would cross the cap, naming the cap and current spend', () => {
    // Actual charges can overrun an allotment, so a $14.90 total is reachable.
    const check = checkBudget(ledger(3.95, 5, 5.95), 'banks', 0.2);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain('$15.00 cap');
      expect(check.reason).toContain('total spent so far $14.90');
    }
  });

  it('refuses a call that would cross the driver allotment', () => {
    const check = checkBudget(ledger(3.9, 0, 0), 'discovery', 0.2);
    expect(check).toEqual({ ok: false, reason: expect.stringContaining('discovery allotment of $4.00') });
    expect(checkBudget(ledger(3.9, 0, 0), 'banks', 0.2)).toEqual({ ok: true });
  });

  it('counts admitted-but-uncharged spend', () => {
    expect(checkBudget(EMPTY_LEDGER, 'composer', 1, 3.5).ok).toBe(false);
    expect(checkBudget(EMPTY_LEDGER, 'composer', 1, 2.5).ok).toBe(true);
  });

  it('allows a call landing exactly on the allotment', () => {
    expect(checkBudget(ledger(3.8, 0, 0), 'discovery', 0.2)).toEqual({ ok: true });
  });

  it('takes the tighter of the allotment and the cap as remaining', () => {
    expect(remainingUsd(ledger(1, 0, 0), 'discovery')).toBeCloseTo(3, 10);
    expect(remainingUsd(ledger(1, 5, 4), 'discovery')).toBeCloseTo(3, 10);
    expect(remainingUsd(ledger(1, 5, 7.5), 'discovery')).toBeCloseTo(1.5, 10);
  });

  it('projects the full target when it fits', () => {
    expect(projectInputs({ remainingUsd: 4, costPerInputByArmRun: [0.1, 0.1, 0.05], target: 10, minimum: 8 })).toEqual({
      kind: 'fits',
      inputs: 10,
    });
  });

  it('shrinks to what fits when that is still at or above the minimum', () => {
    expect(projectInputs({ remainingUsd: 3, costPerInputByArmRun: [0.2, 0.1, 0.05, 0.0], target: 10, minimum: 8 })).toEqual({
      kind: 'shrunk',
      inputs: 8,
    });
  });

  it('reports below minimum when the budget covers fewer than the minimum', () => {
    expect(projectInputs({ remainingUsd: 1, costPerInputByArmRun: [0.2, 0.2], target: 10, minimum: 8 })).toEqual({
      kind: 'below-minimum',
      inputs: 2,
    });
  });

  it('does not lose an input to float noise', () => {
    expect(projectInputs({ remainingUsd: 0.3, costPerInputByArmRun: [0.1], target: 10, minimum: 1 })).toEqual({
      kind: 'shrunk',
      inputs: 3,
    });
  });
});
