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
// Free-beta B1 adds a third concern to (1): the same line also carries the
// fields Cloud Logging and Error Reporting read — `severity`, and for errors a
// `message` holding the stack, plus `serviceContext`. The H3 fields are
// untouched, because the jq-ability of these logs is what makes per-generation
// cost auditable.
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

/**
 * Pure accumulator for a PERSISTED UsageSnapshot that grows across requests
 * (IntakeSession.usage — one turn per HTTP request, so a single trace can't
 * accumulate it the way Program.planUsage does). Folds one call's usage into
 * an existing snapshot under a stage label; never mutates `prev`. An undefined
 * usage (failed call) returns `prev` unchanged — consistent with recordUsage.
 */
export function addUsageToSnapshot(
  prev: UsageSnapshot | null,
  stage: string,
  usage: UsageLike | undefined,
): UsageSnapshot | null {
  if (!usage) return prev;
  const stages: Record<string, StageUsage> = {};
  for (const [k, u] of Object.entries(prev?.stages ?? {})) stages[k] = { ...u };
  const entry = stages[stage] ?? { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  entry.calls += 1;
  entry.inputTokens += usage.inputTokens ?? 0;
  entry.outputTokens += usage.outputTokens ?? 0;
  entry.totalTokens += usage.totalTokens ?? 0;
  stages[stage] = entry;
  const totals: StageUsage = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const u of Object.values(stages)) {
    totals.calls += u.calls;
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.totalTokens += u.totalTokens;
  }
  return { stages, totals };
}

// JSON.stringify drops Error objects to {} — surface what matters instead.
// `stack` is kept because Error Reporting groups on stack frames (see emit).
function serializable(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
  }
  // A caller-supplied object carrying a stack (a client-reported error) is
  // shallow-copied so takeStack's delete can't mutate the caller's own object.
  if (value && typeof value === 'object' && 'stack' in value) return { ...value };
  return value;
}

// Free-beta B1: Cloud Logging's severity vocabulary. Anything below ERROR is
// invisible to Error Reporting, which is why the mapping (not the stack) is what
// decides whether an error page anyone.
const SEVERITY: Record<LogLevel, string> = { info: 'INFO', warn: 'WARNING', error: 'ERROR' };

// Error Reporting's auto-grouping key. Per the current docs, an entry groups
// when `message` (or `stack_trace`/`exception`) holds a stack trace in a
// supported language format — `@type` is only needed for a stack-less error,
// where there are no frames to group on and the message text is all there is.
const REPORTED_ERROR_TYPE =
  'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

/**
 * Moves the first stack found among a line's fields OUT of its field and
 * returns it, for the caller to put in `message`. Call sites pass the Error
 * under varying keys (`err`, `error`, `cause`) and some pass a pre-serialized
 * `{ name, message, stack }`, so both shapes are accepted.
 *
 * It moves rather than copies because a stack is by far the largest thing in an
 * error line and Cloud Logging bills ingestion by volume: leaving it in place
 * would put every stack in the line twice. The field keeps its `name`/`message`,
 * so `jq` still reads the error without the frames.
 */
export function takeStack(line: Record<string, unknown>): string | null {
  for (const value of Object.values(line)) {
    if (!value || typeof value !== 'object' || !('stack' in value)) continue;
    const holder = value as { stack?: unknown };
    if (typeof holder.stack !== 'string' || !holder.stack) continue;
    const stack = holder.stack;
    delete holder.stack;
    return stack;
  }
  return null;
}

// Cloud Run injects K_SERVICE/K_REVISION; the worker (a tsx process on a plain
// VM) has neither, so it names itself via LOG_SERVICE_NAME. Without this the
// app's and the worker's errors group under one service in Error Reporting.
// process.env is read here rather than in a feature module per the env-access
// convention — this file is the leaf.
export function serviceContext(env: {
  K_SERVICE?: string;
  K_REVISION?: string;
  LOG_SERVICE_NAME?: string;
}): { service: string; version?: string } {
  const service = env.K_SERVICE ?? env.LOG_SERVICE_NAME ?? 'learning-app';
  const version = env.K_REVISION;
  return version ? { service, version } : { service };
}

let cachedServiceContext: { service: string; version?: string } | null = null;

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    severity: SEVERITY[level],
  };
  const traceId = currentTraceId();
  if (traceId) line.traceId = traceId;
  if (fields) for (const [k, v] of Object.entries(fields)) line[k] = serializable(v);
  if (level === 'error') {
    cachedServiceContext ??= serviceContext({
      K_SERVICE: process.env.K_SERVICE,
      K_REVISION: process.env.K_REVISION,
      LOG_SERVICE_NAME: process.env.LOG_SERVICE_NAME,
    });
    line.serviceContext = cachedServiceContext;
    const stack = takeStack(line);
    // The stack's own first line already carries "Name: message", so the event
    // prefix rides ahead of it: the parser treats everything before the first
    // "    at " frame as the message, and the grouping uses the frames.
    if (stack) line.message = `${event}: ${stack}`;
    else {
      line.message = event;
      line['@type'] = REPORTED_ERROR_TYPE;
    }
  }
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
