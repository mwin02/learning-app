import { z } from 'zod';
import { PRO_MODEL_ID } from '@/lib/ai/models';
import { callCost, jaccard, latencySummary, type ArmName } from '@/lib/ai/model-compare';
import { shuffle, type Rng } from '@/lib/ai/bank-compare';
import type { CompareCallRecord } from '@/lib/ai/compare-scope';
import type { Bar, Verdict } from '@/lib/ai/discovery-compare';
import type { ComposerResult } from '@/lib/agents/track/composer';
import type { ValidationOutput } from '@/lib/agents/track/validate-composition';

// Scoring and the human side-by-side for the `trackComposer` comparison
// (`pro-to-flash.md`, "Pass bars → `trackComposer`"). Pure;
// scripts/compare-composer-models.ts does the I/O.

export type CompositionRecord = {
  // One sorted slug list per validated lesson, in teaching order.
  lessonConceptSets: string[][];
  intent: string;
  enough: boolean;
  thinForBudget: number;
  needsThicken: boolean;
  fallbackWarnings: number;
  trackTitle: string;
  trackSummary: string;
  lessons: { title: string; summary: string }[];
};

// Matches validate-composition.ts's resolveResources warning: the composer graded a
// mandatory core and none of it survived, so a primary was picked for it.
export const PRIMARY_FALLBACK_WARNING = /fell back to top candidate/;

// The same trigger build-track.ts uses to run a thicken cycle.
export const needsThicken = (rs: ComposerResult['resourceSufficiency']) => !rs.enough || rs.thinForBudget.length > 0;

export function extractRecord(
  composition: Pick<ComposerResult, 'intent' | 'resourceSufficiency' | 'trackTitle' | 'trackSummary'>,
  validation: ValidationOutput,
): CompositionRecord {
  const rs = composition.resourceSufficiency;
  return {
    lessonConceptSets: validation.lessons.map((l) => [...l.conceptSlugs].sort()),
    intent: composition.intent,
    enough: rs.enough,
    thinForBudget: rs.thinForBudget.length,
    needsThicken: needsThicken(rs),
    fallbackWarnings: validation.warnings.filter((w) => PRIMARY_FALLBACK_WARNING.test(w)).length,
    trackTitle: composition.trackTitle,
    trackSummary: composition.trackSummary,
    lessons: validation.lessons.map((l) => ({ title: l.title, summary: l.summary })),
  };
}

// Each lesson is one element (its concept set), so the score drops both when a
// concept is in or out and when the same concepts are grouped into different lessons.
export function lessonJaccard(a: CompositionRecord, b: CompositionRecord): number {
  const keys = (r: CompositionRecord) => r.lessonConceptSets.map((set) => set.join('+'));
  return jaccard(keys(a), keys(b));
}

// The thicken decision as the plan's bar reads it: `enough` and whether
// `thinForBudget` is non-empty (the two decide what the thickener sources).
const sameThicken = (a: CompositionRecord, b: CompositionRecord) =>
  a.enough === b.enough && a.thinForBudget > 0 === b.thinForBudget > 0;

// One composition under one arm run. `record` is null when the composer call or the
// validation threw; `composerCalls` holds the sink's `trackComposer` attempts.
export type CompositionOutcome = {
  compositionId: string;
  record: CompositionRecord | null;
  composerCalls: CompareCallRecord[];
  error?: string;
};

const usdPerCompositionSchema = z.object({
  pro: z.number().nullable(),
  flashIntro: z.number().nullable(),
  flash2027: z.number().nullable(),
});
type UsdPerComposition = z.infer<typeof usdPerCompositionSchema>;

// A schema, not just a type: --human-read reads these back from the results JSONL.
const composerRunMetricsSchema = z.object({
  compositions: z.number(),
  errors: z.number(),
  // Compositions with a valid baseline-run-1 result: the agreement denominators.
  compared: z.number(),
  meanJaccard: z.number().nullable(),
  thickenAgreement: z.number().nullable(),
  thickens: z.number(),
  // Arm said no thicken where both baseline runs said thicken.
  skippedThickens: z.number(),
  fallbackWarnings: z.number(),
  intentAgreement: z.number().nullable(),
  p50LatencyMs: z.number().nullable(),
  maxLatencyMs: z.number().nullable(),
  failedAttempts: z.number(),
  usdPerComposition: usdPerCompositionSchema,
});
export type ComposerRunMetrics = z.infer<typeof composerRunMetricsSchema>;

// Composer calls only, each at its own model's rates.
function perComposition(calls: readonly CompareCallRecord[], compositions: number): UsdPerComposition {
  let pro = 0;
  let intro = 0;
  let y2027 = 0;
  let proCalls = 0;
  let flashCalls = 0;
  for (const call of calls) {
    const cost = callCost(call);
    if (call.modelId === PRO_MODEL_ID) {
      pro += cost.intro;
      proCalls += 1;
    } else {
      intro += cost.intro;
      y2027 += cost['2027'];
      flashCalls += 1;
    }
  }
  const per = (usd: number, n: number) => (n === 0 || compositions === 0 ? null : usd / compositions);
  return { pro: per(pro, proCalls), flashIntro: per(intro, flashCalls), flash2027: per(y2027, flashCalls) };
}

const byId = (outcomes: readonly CompositionOutcome[]) => new Map(outcomes.map((o) => [o.compositionId, o.record]));
const mean = (xs: readonly number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

// Agreement is against baseline run 1. A composition the arm failed counts as a
// disagreement on every agreement metric (the arm caused it); one baseline run 1
// failed has no reference and is left out of the denominators.
export function summarizeRun(
  outcomes: readonly CompositionOutcome[],
  run1: readonly CompositionOutcome[],
  run2: readonly CompositionOutcome[],
): ComposerRunMetrics {
  const ref1 = byId(run1);
  const ref2 = byId(run2);
  const jaccards: number[] = [];
  const thicken: boolean[] = [];
  const intent: boolean[] = [];
  let skippedThickens = 0;
  for (const o of outcomes) {
    const r1 = ref1.get(o.compositionId);
    const r2 = ref2.get(o.compositionId);
    if (o.record !== null && !o.record.needsThicken && r1?.needsThicken && r2?.needsThicken) skippedThickens += 1;
    if (!r1) continue;
    jaccards.push(o.record === null ? 0 : lessonJaccard(o.record, r1));
    thicken.push(o.record !== null && sameThicken(o.record, r1));
    intent.push(o.record !== null && o.record.intent === r1.intent);
  }
  const rate = (xs: readonly boolean[]) => mean(xs.map((x) => (x ? 1 : 0)));
  const calls = outcomes.flatMap((o) => o.composerCalls);
  // Failed attempts return early and would flatter the p50.
  const latency = latencySummary(calls.filter((c) => c.outcome === 'ok').map((c) => c.durationMs));
  const records = outcomes.flatMap((o) => (o.record === null ? [] : [o.record]));
  return {
    compositions: outcomes.length,
    errors: outcomes.filter((o) => o.record === null).length,
    compared: jaccards.length,
    meanJaccard: mean(jaccards),
    thickenAgreement: rate(thicken),
    thickens: records.filter((r) => r.needsThicken).length,
    skippedThickens,
    fallbackWarnings: records.reduce((sum, r) => sum + r.fallbackWarnings, 0),
    intentAgreement: rate(intent),
    p50LatencyMs: latency.p50,
    maxLatencyMs: latency.max,
    failedAttempts: calls.filter((c) => c.outcome !== 'ok').length,
    usdPerComposition: perComposition(calls, outcomes.length),
  };
}

const baselineSummarySchema = z.object({
  run1: composerRunMetricsSchema,
  run2: composerRunMetricsSchema,
  // Mean run-2-vs-run-1 Jaccard over compositions valid in both runs; a failed
  // baseline composition is left out (and printed by the driver).
  yardstick: z.number().nullable(),
  bothValid: z.number(),
  // Pooled over both runs' successful attempts.
  p50LatencyMs: z.number().nullable(),
  maxLatencyMs: z.number().nullable(),
});
export type BaselineSummary = z.infer<typeof baselineSummarySchema>;

export function summarizeBaseline(run1: readonly CompositionOutcome[], run2: readonly CompositionOutcome[]): BaselineSummary {
  const ref2 = byId(run2);
  const pairs = run1.flatMap((o) => {
    const r2 = ref2.get(o.compositionId);
    return o.record !== null && r2 ? [lessonJaccard(r2, o.record)] : [];
  });
  const latency = latencySummary(
    [...run1, ...run2].flatMap((o) => o.composerCalls).filter((c) => c.outcome === 'ok').map((c) => c.durationMs),
  );
  return {
    run1: summarizeRun(run1, run1, run2),
    run2: summarizeRun(run2, run1, run2),
    yardstick: mean(pairs),
    bothValid: pairs.length,
    p50LatencyMs: latency.p50,
    maxLatencyMs: latency.max,
  };
}

function bar(name: string, measured: number | null, comparator: Bar['comparator'], threshold: number | null): Bar {
  const pass =
    measured !== null && threshold !== null && (comparator === '>=' ? measured >= threshold : measured <= threshold);
  return { name, measured, comparator, threshold, pass };
}

// The bars as written 2026-10-07, before any result. Never move them after a run.
// The human read is not here: it gates the final verdict (bank-compare's `finalVerdict`).
export function composerBars(
  arm: ComposerRunMetrics,
  baseline: BaselineSummary,
): { bars: Bar[]; verdict: Verdict; reason?: string } {
  const { run1, run2, yardstick } = baseline;
  const bars = [
    bar('mean lesson Jaccard vs baseline run 1 ≥ run-2 yardstick − 0.10', arm.meanJaccard, '>=', yardstick === null ? null : yardstick - 0.1),
    bar('thicken decision matches baseline run 1 ≥ 80%', arm.thickenAgreement, '>=', 0.8),
    bar('no thicken where both baselines thickened = 0', arm.skippedThickens, '<=', 0),
    bar('primary-fallback warnings ≤ baseline run 1 + 1', arm.fallbackWarnings, '<=', run1.fallbackWarnings + 1),
    bar('intent matches baseline run 1 ≥ 75%', arm.intentAgreement, '>=', 0.75),
    bar('p50 composer latency ≤ 60% of baseline', arm.p50LatencyMs, '<=', baseline.p50LatencyMs === null ? null : 0.6 * baseline.p50LatencyMs),
  ];
  // Checked first: a skipped thicken is never a speed win, whatever else holds.
  if (arm.skippedThickens > 0) {
    return { bars, verdict: 'FAIL', reason: `${arm.skippedThickens} composition(s) skipped a thicken both baseline runs ran` };
  }
  const vacuous = [
    run1.compositions - run1.errors === 0 ? 'baseline run 1 produced no valid composition' : null,
    run2.compositions - run2.errors === 0 ? 'baseline run 2 produced no valid composition' : null,
    yardstick === null ? 'no composition is valid in both baseline runs, so there is no Jaccard yardstick' : null,
  ].filter((r): r is string => r !== null);
  if (vacuous.length > 0) return { bars, verdict: 'INCONCLUSIVE', reason: vacuous.join('; ') };
  return { bars, verdict: bars.every((b) => b.pass) ? 'PASS' : 'FAIL' };
}

export type SideBySideItem = {
  compositionId: string;
  heading: string;
  learner: string;
  baseline: CompositionRecord;
  candidate: CompositionRecord;
};
export type SideBySideKey = Record<string, { A: ArmName; B: ArmName; compositionId: string }>;

// Baseline run 1 and the candidate per composition, sides assigned at random. The
// markdown never names an arm or model; the key file does.
export function sideBySide(items: readonly SideBySideItem[], candidate: ArmName, rng: Rng): { markdown: string; key: SideBySideKey } {
  const key: SideBySideKey = {};
  const render = (r: CompositionRecord) =>
    [`**${r.trackTitle}**`, '', r.trackSummary, '', ...r.lessons.map((l, i) => `${i + 1}. **${l.title}** — ${l.summary}`)].join('\n');
  const sections = shuffle(items, rng).map((item, i) => {
    const id = `S${i + 1}`;
    const baselineIsA = rng() < 0.5;
    const [a, b] = baselineIsA ? [item.baseline, item.candidate] : [item.candidate, item.baseline];
    key[id] = { A: baselineIsA ? 'baseline' : candidate, B: baselineIsA ? candidate : 'baseline', compositionId: item.compositionId };
    return [`## ${id} · ${item.heading}`, '', item.learner, '', '### A', '', render(a), '', '### B', '', render(b), '', '- [ ] prefer A', '- [ ] prefer B', '- [ ] no preference', '- [ ] veto A', '- [ ] veto B'].join('\n');
  });
  const header = [
    '# Side-by-side read: course framing',
    '',
    `${sections.length} compositions, each written twice for the same learner. Judge the track title, summary and lesson framing. Score against the separate key file only after reading all of them.`,
  ].join('\n');
  return { markdown: `${[header, ...sections].join('\n\n')}\n`, key };
}

const armNameSchema = z.enum(['baseline', 'flash-low', 'flash-default', 'pro-low'] as const satisfies readonly ArmName[]);

const verdictRowSchema = z.object({
  kind: z.literal('verdict'),
  runId: z.string(),
  arm: armNameSchema,
  verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  reason: z.string().optional(),
  bars: z.array(
    z.object({
      name: z.string(),
      measured: z.number().nullable(),
      comparator: z.enum(['>=', '<=']),
      threshold: z.number().nullable(),
      pass: z.boolean(),
    }),
  ),
  metrics: composerRunMetricsSchema,
  baseline: baselineSummarySchema,
});
export type ComposerVerdictRow = z.infer<typeof verdictRowSchema>;

const runEndRowSchema = z.object({ kind: z.literal('run-end'), runId: z.string(), candidate: armNameSchema.nullable() });

// The last run that reached its end, with its arm verdicts, so --human-read can
// record the user's read without composing anything.
export function lastCompletedRun(
  rows: readonly unknown[],
): { runId: string; candidate: ArmName | null; verdicts: ComposerVerdictRow[] } | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const end = runEndRowSchema.safeParse(rows[i]);
    if (!end.success) continue;
    const verdicts = rows.flatMap((row) => {
      const parsed = verdictRowSchema.safeParse(row);
      return parsed.success && parsed.data.runId === end.data.runId ? [parsed.data] : [];
    });
    return { runId: end.data.runId, candidate: end.data.candidate, verdicts };
  }
  return null;
}
