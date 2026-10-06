import { describe, expect, it, vi } from 'vitest';

// models.ts's vertex leaf throws at module-eval without GOOGLE_VERTEX_PROJECT.
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  vertexAnthropic: {},
  vertexGlobal: {},
}));

import { FLASH_MODEL_ID, PRO_MODEL_ID } from '@/lib/ai/models';
import type { CompareCallRecord } from '@/lib/ai/compare-scope';
import {
  discoveryBars,
  meanMetrics,
  summarizeRun,
  walkLadder,
  type DiscoveryInputResult,
  type DiscoveryRunMetrics,
} from '@/lib/ai/discovery-compare';

function call(modelId: string, durationMs: number, webSearchQueries = 0): CompareCallRecord {
  return {
    agent: 'curriculumFallback',
    modelId,
    durationMs,
    outcome: 'ok',
    inputTokens: 1_000_000,
    outputTokens: 0,
    webSearchQueries,
  };
}

function input(attested: number, survivors: number, teaches: number, calls: CompareCallRecord[]): DiscoveryInputResult {
  return { attested, survivors, teaches, discoveryCalls: calls };
}

const metrics = (over: Partial<DiscoveryRunMetrics>): DiscoveryRunMetrics => ({
  inputs: 10,
  medianAttested: 5,
  medianSurvivors: 4,
  teachesSum: 20,
  zeroTeaches: 1,
  p50LatencyMs: 40_000,
  maxLatencyMs: 60_000,
  groundingQueries: 30,
  errors: 0,
  usdPerCall: { pro: 0.1, flashIntro: null, flash2027: null },
  ...over,
});

describe('summarizeRun', () => {
  it('takes medians, sums teaches, counts zero-yield concepts and grounding queries', () => {
    const m = summarizeRun([
      input(6, 4, 3, [call(PRO_MODEL_ID, 30_000, 2)]),
      input(2, 1, 0, [call(PRO_MODEL_ID, 50_000, 3)]),
      input(4, 3, 2, [call(PRO_MODEL_ID, 10_000, 1)]),
    ]);
    expect(m.medianAttested).toBe(4);
    expect(m.medianSurvivors).toBe(3);
    expect(m.teachesSum).toBe(5);
    expect(m.zeroTeaches).toBe(1);
    expect(m.p50LatencyMs).toBe(30_000);
    expect(m.maxLatencyMs).toBe(50_000);
    expect(m.groundingQueries).toBe(6);
  });

  it('costs Pro calls in the Pro column and Flash calls at both Flash price points', () => {
    const pro = summarizeRun([input(1, 1, 1, [call(PRO_MODEL_ID, 1)])]).usdPerCall;
    expect(pro).toEqual({ pro: 2, flashIntro: null, flash2027: null });
    const flash = summarizeRun([input(1, 1, 1, [call(FLASH_MODEL_ID, 1, 1000)])]).usdPerCall;
    expect(flash.pro).toBeNull();
    expect(flash.flashIntro).toBeCloseTo(0.75 + 14);
    expect(flash.flash2027).toBeCloseTo(1.5 + 14);
  });

  it('counts an errored input as zero-yield and as an error', () => {
    const m = summarizeRun([{ attested: 0, survivors: 0, teaches: 0, discoveryCalls: [], error: 'boom' }]);
    expect(m.zeroTeaches).toBe(1);
    expect(m.errors).toBe(1);
    expect(m.p50LatencyMs).toBeNull();
  });
});

describe('meanMetrics', () => {
  it('averages two baseline runs metric by metric, ignoring a missing latency', () => {
    const m = meanMetrics([
      metrics({ medianAttested: 4, teachesSum: 10, p50LatencyMs: 30_000 }),
      metrics({ medianAttested: 6, teachesSum: 20, p50LatencyMs: null }),
    ]);
    expect(m.medianAttested).toBe(5);
    expect(m.teachesSum).toBe(15);
    expect(m.p50LatencyMs).toBe(30_000);
  });
});

describe('discoveryBars', () => {
  const baseline = metrics({});

  it('passes an arm that clears every bar exactly at its threshold', () => {
    const arm = metrics({ medianAttested: 4, medianSurvivors: 3.2, teachesSum: 18, zeroTeaches: 2, p50LatencyMs: 24_000 });
    const { bars, verdict } = discoveryBars(arm, baseline);
    expect(bars).toHaveLength(5);
    expect(bars.every((b) => b.pass)).toBe(true);
    expect(verdict).toBe('PASS');
  });

  it('fails the verdict when any single bar fails, and reports measured and threshold', () => {
    const { bars, verdict } = discoveryBars(metrics({ p50LatencyMs: 24_001 }), baseline);
    expect(verdict).toBe('FAIL');
    const latency = bars.find((b) => b.name.startsWith('p50'));
    expect(latency).toMatchObject({ measured: 24_001, threshold: 24_000, comparator: '<=', pass: false });
    expect(bars.filter((b) => !b.pass)).toHaveLength(1);
  });

  it('fails on one more zero-yield concept than the allowance', () => {
    expect(discoveryBars(metrics({ zeroTeaches: 3 }), baseline).verdict).toBe('FAIL');
  });

  it('fails the latency bar when either side has no measured discovery call', () => {
    expect(discoveryBars(metrics({ p50LatencyMs: null }), baseline).verdict).toBe('FAIL');
    expect(discoveryBars(metrics({ p50LatencyMs: 1 }), metrics({ p50LatencyMs: null })).verdict).toBe('FAIL');
  });

  it('is INCONCLUSIVE, never PASS, when the baseline summed teaches is 0', () => {
    const zero = metrics({ teachesSum: 0, zeroTeaches: 10 });
    const out = discoveryBars(metrics({ teachesSum: 0, zeroTeaches: 10, p50LatencyMs: 1 }), zero);
    expect(out.bars.every((b) => b.pass)).toBe(true);
    expect(out.verdict).toBe('INCONCLUSIVE');
    expect(out.reason).toContain('summed teaches');
  });

  it('is INCONCLUSIVE when the baseline median attested is 0', () => {
    const out = discoveryBars(metrics({ medianAttested: 0, p50LatencyMs: 1 }), metrics({ medianAttested: 0 }));
    expect(out.verdict).toBe('INCONCLUSIVE');
    expect(out.reason).toContain('median attested');
  });
});

describe('walkLadder', () => {
  it('stops after the first passing arm', async () => {
    const ran: string[] = [];
    const outcomes = await walkLadder(['flash-low', 'flash-default'] as const, async (arm) => {
      ran.push(arm);
      return { verdict: 'PASS' as const, result: arm };
    });
    expect(ran).toEqual(['flash-low']);
    expect(outcomes).toEqual([{ arm: 'flash-low', verdict: 'PASS', result: 'flash-low' }]);
  });

  it('stops on INCONCLUSIVE without trying the next arm', async () => {
    const ran: string[] = [];
    await walkLadder(['flash-low', 'flash-default'] as const, async (arm) => {
      ran.push(arm);
      return { verdict: 'INCONCLUSIVE' as const, result: null };
    });
    expect(ran).toEqual(['flash-low']);
  });

  it('runs the next arm after a failing one, and every arm when all fail', async () => {
    const ran: string[] = [];
    const outcomes = await walkLadder(['flash-low', 'flash-default', 'pro-low'] as const, async (arm) => {
      ran.push(arm);
      return { verdict: arm === 'flash-default' ? ('PASS' as const) : ('FAIL' as const), result: null };
    });
    expect(ran).toEqual(['flash-low', 'flash-default']);
    expect(outcomes.map((o) => o.verdict)).toEqual(['FAIL', 'PASS']);

    const all: string[] = [];
    await walkLadder(['flash-low', 'flash-default'] as const, async (arm) => {
      all.push(arm);
      return { verdict: 'FAIL' as const, result: null };
    });
    expect(all).toEqual(['flash-low', 'flash-default']);
  });
});
