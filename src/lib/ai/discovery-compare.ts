import { PRO_MODEL_ID } from '@/lib/ai/models';
import { callCost, latencySummary, median, type ArmName } from '@/lib/ai/model-compare';
import type { CompareCallRecord } from '@/lib/ai/compare-scope';

// Scoring for the `curriculumFallback` comparison (`pro-to-flash.md`, "Pass bars →
// `curriculumFallback`"). Pure; scripts/compare-discovery-models.ts does the I/O.

// One concept replayed through rung 1 under one arm.
export type DiscoveryInputResult = {
  attested: number;
  survivors: number;
  teaches: number;
  // The sink's records for `curriculumFallback` only; the describer, validity and
  // judge calls it triggers are charged to the ledger but are not under test.
  discoveryCalls: CompareCallRecord[];
  error?: string;
};

// Dollars per discovery call, each call costed at its own model's rates. A Pro call
// has one price, so it fills `pro`; a Flash call fills both Flash columns.
export type UsdPerCall = { pro: number | null; flashIntro: number | null; flash2027: number | null };

export type DiscoveryRunMetrics = {
  inputs: number;
  medianAttested: number;
  medianSurvivors: number;
  teachesSum: number;
  zeroTeaches: number;
  p50LatencyMs: number | null;
  maxLatencyMs: number | null;
  groundingQueries: number;
  errors: number;
  usdPerCall: UsdPerCall;
};

function perCall(records: readonly CompareCallRecord[]): UsdPerCall {
  let pro = 0;
  let proCalls = 0;
  let intro = 0;
  let y2027 = 0;
  let flashCalls = 0;
  for (const record of records) {
    const cost = callCost(record);
    if (record.modelId === PRO_MODEL_ID) {
      pro += cost.intro;
      proCalls += 1;
    } else {
      intro += cost.intro;
      y2027 += cost['2027'];
      flashCalls += 1;
    }
  }
  return {
    pro: proCalls === 0 ? null : pro / proCalls,
    flashIntro: flashCalls === 0 ? null : intro / flashCalls,
    flash2027: flashCalls === 0 ? null : y2027 / flashCalls,
  };
}

export function summarizeRun(results: readonly DiscoveryInputResult[]): DiscoveryRunMetrics {
  const calls = results.flatMap((r) => r.discoveryCalls);
  const latency = latencySummary(calls.map((c) => c.durationMs));
  return {
    inputs: results.length,
    medianAttested: median(results.map((r) => r.attested)) ?? 0,
    medianSurvivors: median(results.map((r) => r.survivors)) ?? 0,
    teachesSum: results.reduce((sum, r) => sum + r.teaches, 0),
    zeroTeaches: results.filter((r) => r.teaches === 0).length,
    p50LatencyMs: latency.p50,
    maxLatencyMs: latency.max,
    groundingQueries: calls.reduce((sum, c) => sum + c.webSearchQueries, 0),
    errors: results.filter((r) => r.error !== undefined).length,
    usdPerCall: perCall(calls),
  };
}

function meanOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

// The plan's baseline is "the mean of its two runs", taken metric by metric.
export function meanMetrics(runs: readonly DiscoveryRunMetrics[]): DiscoveryRunMetrics {
  if (runs.length === 0) throw new Error('meanMetrics needs at least one run');
  const mean = (pick: (m: DiscoveryRunMetrics) => number | null) => meanOf(runs.map(pick));
  const required = (pick: (m: DiscoveryRunMetrics) => number) => mean(pick) ?? 0;
  return {
    inputs: required((m) => m.inputs),
    medianAttested: required((m) => m.medianAttested),
    medianSurvivors: required((m) => m.medianSurvivors),
    teachesSum: required((m) => m.teachesSum),
    zeroTeaches: required((m) => m.zeroTeaches),
    p50LatencyMs: mean((m) => m.p50LatencyMs),
    maxLatencyMs: mean((m) => m.maxLatencyMs),
    groundingQueries: required((m) => m.groundingQueries),
    errors: required((m) => m.errors),
    usdPerCall: {
      pro: mean((m) => m.usdPerCall.pro),
      flashIntro: mean((m) => m.usdPerCall.flashIntro),
      flash2027: mean((m) => m.usdPerCall.flash2027),
    },
  };
}

export type Bar = {
  name: string;
  measured: number | null;
  comparator: '>=' | '<=';
  threshold: number | null;
  pass: boolean;
};

function bar(name: string, measured: number | null, comparator: Bar['comparator'], threshold: number | null): Bar {
  // A missing measurement (no discovery call completed) can't clear a bar.
  const pass =
    measured !== null &&
    threshold !== null &&
    (comparator === '>=' ? measured >= threshold : measured <= threshold);
  return { name, measured, comparator, threshold, pass };
}

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

// The bars as written 2026-10-07, before any result. Never move them after a run.
// A baseline with no yield makes the yield bars pass vacuously (0 >= 0), leaving
// latency alone to decide, so such a comparison is INCONCLUSIVE, never PASS.
export function discoveryBars(
  arm: DiscoveryRunMetrics,
  baseline: DiscoveryRunMetrics,
): { bars: Bar[]; verdict: Verdict; reason?: string } {
  const bars = [
    bar('median attested ≥ 80% of baseline', arm.medianAttested, '>=', 0.8 * baseline.medianAttested),
    bar('median survivors ≥ 80% of baseline', arm.medianSurvivors, '>=', 0.8 * baseline.medianSurvivors),
    bar('summed teaches ≥ 90% of baseline', arm.teachesSum, '>=', 0.9 * baseline.teachesSum),
    bar('zero-teaches concepts ≤ baseline + 1', arm.zeroTeaches, '<=', baseline.zeroTeaches + 1),
    bar(
      'p50 discovery latency ≤ 60% of baseline',
      arm.p50LatencyMs,
      '<=',
      baseline.p50LatencyMs === null ? null : 0.6 * baseline.p50LatencyMs,
    ),
  ];
  const zero = [
    baseline.teachesSum === 0 ? 'summed teaches' : null,
    baseline.medianAttested === 0 ? 'median attested' : null,
  ].filter((m): m is string => m !== null);
  if (zero.length > 0) {
    return { bars, verdict: 'INCONCLUSIVE', reason: `baseline ${zero.join(' and ')} is 0, so the yield bars cannot fail` };
  }
  return { bars, verdict: bars.every((b) => b.pass) ? 'PASS' : 'FAIL' };
}

// Runs arms in order; only a FAIL moves on. PASS stops at the winner, and
// INCONCLUSIVE stops because the baseline, not the arm, is the problem.
export async function walkLadder<A extends ArmName, R>(
  arms: readonly A[],
  run: (arm: A) => Promise<{ verdict: Verdict; result: R }>,
): Promise<{ arm: A; verdict: Verdict; result: R }[]> {
  const outcomes: { arm: A; verdict: Verdict; result: R }[] = [];
  for (const arm of arms) {
    const outcome = await run(arm);
    outcomes.push({ arm, ...outcome });
    if (outcome.verdict !== 'FAIL') break;
  }
  return outcomes;
}
