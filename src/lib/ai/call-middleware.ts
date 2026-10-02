import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { log, logWarn, recordTiming } from '@/lib/log';

// `ai` does not re-export the provider spec's LanguageModelV3 by name.
export type WrappableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

export type CallOutcome = 'ok' | 'error' | 'aborted';

// A provider surfaces a caller abort as a DOMException/AbortError, or as some
// other error thrown once the signal fires; either way the signal is the truth.
export function callOutcome(err: unknown, signal: AbortSignal | undefined): CallOutcome {
  if (signal?.aborted) return 'aborted';
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return 'aborted';
  }
  return 'error';
}

// Times each doGenerate attempt: generateText's retries call through the wrapped
// model, so a retried call logs one line per attempt. Failures log at warning,
// never error — the caller decides whether a failed call is a fault.
export function callTimingMiddleware(agent: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const start = performance.now();
      const base = { agent, modelId: model.modelId };
      try {
        const result = await doGenerate();
        const durationMs = Math.round(performance.now() - start);
        recordTiming(`ai.${agent}`, durationMs);
        log('ai.call', {
          ...base,
          durationMs,
          outcome: 'ok',
          inputTokens: result.usage.inputTokens.total,
          outputTokens: result.usage.outputTokens.total,
          reasoningTokens: result.usage.outputTokens.reasoning,
          finishReason: result.finishReason.unified,
        });
        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        recordTiming(`ai.${agent}`, durationMs);
        logWarn('ai.call', {
          ...base,
          durationMs,
          outcome: callOutcome(err, params.abortSignal),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

export function withCallTiming(model: WrappableModel, agent: string): WrappableModel {
  return wrapLanguageModel({ model, middleware: callTimingMiddleware(agent) });
}
