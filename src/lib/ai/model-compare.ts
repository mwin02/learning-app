import { z } from 'zod';
import { FLASH_MODEL_ID, PRO_MODEL_ID, type AgentName } from '@/lib/ai/models';
import type { AgentOverride, CompareCallRecord } from '@/lib/ai/compare-scope';

// Pure half of the Pro-to-Flash comparison harness (`pro-to-flash.md`): arms,
// prices, cost, stats, and the budget arithmetic. File I/O lives in
// scripts/model-compare-harness.ts.

export const ARMS = {
  // Today's registry config, unchanged.
  baseline: {},
  'flash-low': { modelId: FLASH_MODEL_ID, thinkingLevel: 'low' },
  // `null` clears a registry `low` (curriculumFallback) back to the model default.
  'flash-default': { modelId: FLASH_MODEL_ID, thinkingLevel: null },
  'pro-low': { modelId: PRO_MODEL_ID, thinkingLevel: 'low' },
} as const satisfies Record<string, AgentOverride>;

export type ArmName = keyof typeof ARMS;

// Cheapest first; a driver stops at the first arm that passes.
export const LADDER = ['flash-low', 'flash-default', 'pro-low'] as const satisfies readonly ArmName[];

export function armOverrides(arm: ArmName, agent: AgentName): Partial<Record<AgentName, AgentOverride>> {
  return { [agent]: ARMS[arm] };
}

export const PRICE_POINTS = ['intro', '2027'] as const;
export type PricePoint = (typeof PRICE_POINTS)[number];

type Rate = { inputPerM: number; outputPerM: number };

// USD per 1M tokens, Vertex AI pricing as read 2026-09-28. Keyed by literal id,
// not the registry constants: a price belongs to an id, so retargeting the
// registry must fail `callCost` until the new id is priced here.
const PRICES: Record<string, Record<PricePoint, Rate>> = {
  'gemini-3.1-pro-preview': {
    intro: { inputPerM: 2, outputPerM: 12 },
    '2027': { inputPerM: 2, outputPerM: 12 },
  },
  'gemini-3.7-flash': {
    intro: { inputPerM: 0.75, outputPerM: 3.75 },
    '2027': { inputPerM: 1.5, outputPerM: 7.5 },
  },
};

// Grounding with Google Search, per query. The 5,000/month free tier is ignored:
// it is shared with production and its remaining balance isn't visible.
const GROUNDING_USD_PER_QUERY = 14 / 1000;

const FLASH_2027_FROM = Date.UTC(2027, 0, 1);

export function pricePointOn(date: Date): PricePoint {
  return date.getTime() < FLASH_2027_FROM ? 'intro' : '2027';
}

export type CostByPricePoint = Record<PricePoint, number>;

// `outputTokens` already includes thinking (the Google provider reports
// total = candidates + thoughts), so `reasoningTokens` is not added again.
// A failed attempt carries no usage and costs only its (zero) grounding queries.
export function callCost(
  record: Pick<CompareCallRecord, 'modelId' | 'inputTokens' | 'outputTokens' | 'webSearchQueries'>,
): CostByPricePoint {
  const rates = PRICES[record.modelId];
  if (rates === undefined) throw new Error(`no price for model ${record.modelId}; add it to PRICES`);
  const grounding = record.webSearchQueries * GROUNDING_USD_PER_QUERY;
  const at = (rate: Rate) =>
    ((record.inputTokens ?? 0) * rate.inputPerM + (record.outputTokens ?? 0) * rate.outputPerM) / 1e6 +
    grounding;
  return { intro: at(rates.intro), '2027': at(rates['2027']) };
}

export function totalCost(records: readonly CompareCallRecord[]): CostByPricePoint {
  const total: CostByPricePoint = { intro: 0, '2027': 0 };
  for (const record of records) {
    const cost = callCost(record);
    total.intro += cost.intro;
    total['2027'] += cost['2027'];
  }
  return total;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function latencySummary(durationsMs: readonly number[]): { p50: number | null; max: number | null } {
  return { p50: median(durationsMs), max: durationsMs.length === 0 ? null : Math.max(...durationsMs) };
}

// Two empty sets are identical, so 1.
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / union.size;
}

export const DRIVERS = ['discovery', 'banks', 'composer'] as const;
export type Driver = (typeof DRIVERS)[number];

export const SPEND_CAP_USD = 15;
// The $2 reserve is not a driver's: spending it means raising an allotment here.
export const ALLOTMENTS_USD: Record<Driver, number> = { discovery: 4, banks: 5, composer: 4 };

export const ledgerSchema = z.object({
  spentUsd: z.object({
    discovery: z.number().nonnegative(),
    banks: z.number().nonnegative(),
    composer: z.number().nonnegative(),
  }),
});
export type Ledger = z.infer<typeof ledgerSchema>;

export const EMPTY_LEDGER: Ledger = { spentUsd: { discovery: 0, banks: 0, composer: 0 } };

export function ledgerTotal(ledger: Ledger): number {
  return DRIVERS.reduce((sum, driver) => sum + ledger.spentUsd[driver], 0);
}

// Absorbs float noise in sums of per-call costs, which are fractions of a cent.
const EPSILON_USD = 1e-9;

// Room left for `driver`: the tighter of its allotment and the overall cap.
export function remainingUsd(ledger: Ledger, driver: Driver): number {
  return Math.max(
    0,
    Math.min(ALLOTMENTS_USD[driver] - ledger.spentUsd[driver], SPEND_CAP_USD - ledgerTotal(ledger)),
  );
}

export type BudgetCheck = { ok: true } | { ok: false; reason: string };

// `pendingUsd` is projected cost already admitted but not yet charged, so
// concurrent inputs in one process can't each pass against the same spend.
export function checkBudget(
  ledger: Ledger,
  driver: Driver,
  projectedUsd: number,
  pendingUsd = 0,
): BudgetCheck {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const total = ledgerTotal(ledger) + pendingUsd;
  if (total + projectedUsd > SPEND_CAP_USD + EPSILON_USD) {
    return {
      ok: false,
      reason: `refused: projected ${usd(projectedUsd)} would cross the ${usd(SPEND_CAP_USD)} cap (total spent so far ${usd(total)})`,
    };
  }
  const spent = ledger.spentUsd[driver] + pendingUsd;
  if (spent + projectedUsd > ALLOTMENTS_USD[driver] + EPSILON_USD) {
    return {
      ok: false,
      reason: `refused: projected ${usd(projectedUsd)} would cross the ${driver} allotment of ${usd(ALLOTMENTS_USD[driver])} (${driver} spent so far ${usd(spent)})`,
    };
  }
  return { ok: true };
}

export type Projection =
  | { kind: 'fits'; inputs: number }
  | { kind: 'shrunk'; inputs: number }
  | { kind: 'below-minimum'; inputs: number };

// `costPerInputByArmRun` has one entry per arm-run each input will go through
// (a baseline run twice appears twice), measured in the pilot.
export function projectInputs(args: {
  remainingUsd: number;
  costPerInputByArmRun: readonly number[];
  target: number;
  minimum: number;
}): Projection {
  const perInput = args.costPerInputByArmRun.reduce((sum, cost) => sum + cost, 0);
  const affordable =
    perInput <= 0 ? args.target : Math.floor(args.remainingUsd / perInput + EPSILON_USD);
  const inputs = Math.min(args.target, affordable);
  if (inputs < args.minimum) return { kind: 'below-minimum', inputs };
  return { kind: inputs === args.target ? 'fits' : 'shrunk', inputs };
}
