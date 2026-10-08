import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentName, ThinkingLevel } from '@/lib/ai/models';
import type { CallOutcome } from '@/lib/ai/call-middleware';

// A comparison run's scope: per-agent config overrides that `getModel` applies,
// and a sink `callTimingMiddleware` reports every attempt to. Reachable only by
// calling `runWithCompareScope`; nothing in env or deployment config can set it.
// Its own module so models.ts and call-middleware.ts both import it without a cycle.

// `null` on an optional field clears the registry value back to the model's
// default (no thinkingConfig sent, no per-attempt timeout); omitted keeps it.
export type AgentOverride = {
  modelId?: string;
  thinkingLevel?: ThinkingLevel | null;
  maxOutputTokens?: number;
  callTimeoutMs?: number | null;
};

export type CompareCallRecord = {
  agent: string;
  modelId: string;
  durationMs: number;
  outcome: CallOutcome;
  // Absent on a failed attempt, which has no usage.
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  webSearchQueries: number;
};

export type CompareSink = (record: CompareCallRecord) => void;

export type CompareScope = {
  overrides?: Partial<Record<AgentName, AgentOverride>>;
  sink?: CompareSink;
};

const storage = new AsyncLocalStorage<CompareScope>();

// A nested scope replaces the enclosing one for its duration; nothing is merged.
export function runWithCompareScope<T>(scope: CompareScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

export function agentOverride(agent: AgentName): AgentOverride | undefined {
  return storage.getStore()?.overrides?.[agent];
}

export function compareSink(): CompareSink | undefined {
  return storage.getStore()?.sink;
}
