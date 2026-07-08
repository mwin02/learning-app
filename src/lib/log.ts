// Phase 3 hardening H3 (audit 9.4): structured JSON logging + per-job usage
// accounting. Two cooperating pieces:
//
//   1. log / logWarn / logError — one JSON object per line to stdout/stderr
//      ({ ts, level, event, traceId?, ...fields }), replacing the ad-hoc
//      `console.log('[tag]', {...})` objects so per-generation cost is
//      greppable/parseable (`jq 'select(.traceId=="…")'`) instead of prose.
//
//   2. runWithTrace / recordUsage / traceUsageSnapshot — an AsyncLocalStorage
//      trace context. The job boundary (the generate-program route for the
//      plan pass, the worker tick for a build) opens a trace; any AI call site
//      anywhere down the async call graph reports its token usage with a
//      one-line recordUsage(stage, result.usage) — no parameter threading —
//      and the boundary persists the accumulated snapshot (Program.planUsage /
//      CourseRequest.buildUsage). Outside a trace, recordUsage is a no-op, so
//      scripts and tests that call agents directly are unaffected.
//
// ALS is Node-only, which both consumers are (the route forces runtime
// 'nodejs'; the worker is a tsx process).

import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'info' | 'warn' | 'error';

// The AI SDK's LanguageModelUsage, structurally (kept local so importing this
// module never pulls the `ai` package into a test's module graph).
export type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type StageUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

// The persisted shape (Program.planUsage / CourseRequest.buildUsage).
export type UsageSnapshot = {
  stages: Record<string, StageUsage>;
  totals: StageUsage;
};

type TraceContext = {
  traceId: string;
  usage: Map<string, StageUsage>;
};

const storage = new AsyncLocalStorage<TraceContext>();

/** Run `fn` inside a trace: logs carry `traceId`, recordUsage accumulates. */
export function runWithTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ traceId, usage: new Map() }, fn);
}

export function currentTraceId(): string | null {
  return storage.getStore()?.traceId ?? null;
}

/**
 * Report one AI call's token usage under a stage label ("plan.decompose",
 * "track.compose", …). No-op outside a trace or for an undefined usage
 * (a failed call has none).
 */
export function recordUsage(stage: string, usage: UsageLike | undefined): void {
  const ctx = storage.getStore();
  if (!ctx || !usage) return;
  const entry = ctx.usage.get(stage) ?? { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  entry.calls += 1;
  entry.inputTokens += usage.inputTokens ?? 0;
  entry.outputTokens += usage.outputTokens ?? 0;
  entry.totalTokens += usage.totalTokens ?? 0;
  ctx.usage.set(stage, entry);
}

/**
 * The current trace's accumulated usage, JSON-ready for persistence.
 * Null outside a trace or when nothing was recorded (persist as DB NULL —
 * "not measured", distinct from an all-zero measurement).
 */
export function traceUsageSnapshot(): UsageSnapshot | null {
  const ctx = storage.getStore();
  if (!ctx || ctx.usage.size === 0) return null;
  const stages: Record<string, StageUsage> = {};
  const totals: StageUsage = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const [stage, u] of ctx.usage) {
    stages[stage] = { ...u };
    totals.calls += u.calls;
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.totalTokens += u.totalTokens;
  }
  return { stages, totals };
}

// JSON.stringify drops Error objects to {} — surface what matters instead.
function serializable(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  const traceId = currentTraceId();
  if (traceId) line.traceId = traceId;
  if (fields) for (const [k, v] of Object.entries(fields)) line[k] = serializable(v);
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(JSON.stringify(line));
}

export function log(event: string, fields?: Record<string, unknown>): void {
  emit('info', event, fields);
}

export function logWarn(event: string, fields?: Record<string, unknown>): void {
  emit('warn', event, fields);
}

export function logError(event: string, fields?: Record<string, unknown>): void {
  emit('error', event, fields);
}
