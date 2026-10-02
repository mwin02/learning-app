import { RetryError, wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { log, logWarn, recordTiming } from '@/lib/log';

// `ai` does not re-export the provider spec's LanguageModelV3 by name.
export type WrappableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

type GenerateResult = Awaited<ReturnType<WrappableModel['doGenerate']>>;

export type CallOutcome = 'ok' | 'error' | 'aborted' | 'timeout';

// Attempts per call when every one times out: the first plus one retry.
const TIMEOUT_ATTEMPTS = 2;

// Not named `TimeoutError`: the SDK treats that name as an abort, and so did
// this module's own classifier before per-attempt timeouts existed.
export class CallTimeoutError extends Error {
  readonly agent: string;
  readonly timeoutMs: number;

  constructor(agent: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${agent} model call timed out after ${timeoutMs} ms on ${TIMEOUT_ATTEMPTS} attempts`, options);
    this.name = 'CallTimeoutError';
    this.agent = agent;
    this.timeoutMs = timeoutMs;
  }
}

// After an earlier retryable failure the SDK wraps a later non-retryable error,
// ours included, in a RetryError.
export function callTimeoutErrorOf(err: unknown): CallTimeoutError | undefined {
  if (err instanceof CallTimeoutError) return err;
  if (RetryError.isInstance(err) && err.lastError instanceof CallTimeoutError) return err.lastError;
  return undefined;
}

export function isCallTimeoutError(err: unknown): boolean {
  return callTimeoutErrorOf(err) !== undefined;
}

// The signals are the truth, not error names: a provider surfaces an abort as an
// AbortError or as whatever its fetch threw once the signal fired. The caller's
// signal wins over the timeout's, so a job abort is never retried. A TimeoutError
// with neither signal fired came from something else's own timer, which is a
// failure of the call, so it is `error`.
export function callOutcome(
  err: unknown,
  signal: AbortSignal | undefined,
  timeoutSignal?: AbortSignal,
): CallOutcome {
  if (signal?.aborted) return 'aborted';
  if (timeoutSignal?.aborted) return 'timeout';
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  return 'error';
}

export type CallTimingOptions = {
  // Per-attempt bound. Omitted → attempts run unbounded, under the caller's signal only.
  timeoutMs?: number;
};

// Times each doGenerate attempt: generateText's retries call through the wrapped
// model, so a retried call logs one line per attempt. Failures log at warning,
// never error — the caller decides whether a failed call is a fault.
//
// With `timeoutMs`, each attempt runs under the caller's signal combined with a
// fresh timer, and a timed-out attempt is retried once as a fresh request. The
// retry lives here because the SDK never retries an error that is not a
// retryable APICallError.
export function callTimingMiddleware(
  agent: string,
  options: CallTimingOptions = {},
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const base = { agent, modelId: model.modelId };
      const callerSignal = params.abortSignal;

      const timed = async (
        run: () => PromiseLike<GenerateResult>,
        timeoutSignal: AbortSignal | undefined,
      ): Promise<GenerateResult> => {
        const start = performance.now();
        try {
          const result = await run();
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
            outcome: callOutcome(err, callerSignal, timeoutSignal),
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };

      const { timeoutMs } = options;
      if (timeoutMs === undefined) return timed(doGenerate, undefined);

      for (let attempt = 1; ; attempt += 1) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), timeoutMs);
        const abortSignal = callerSignal
          ? AbortSignal.any([callerSignal, timeout.signal])
          : timeout.signal;
        try {
          return await timed(() => model.doGenerate({ ...params, abortSignal }), timeout.signal);
        } catch (err) {
          if (callerSignal?.aborted || !timeout.signal.aborted) throw err;
          if (attempt >= TIMEOUT_ATTEMPTS) {
            throw new CallTimeoutError(agent, timeoutMs, { cause: err });
          }
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}

export function withCallTiming(
  model: WrappableModel,
  agent: string,
  options: CallTimingOptions = {},
): WrappableModel {
  return wrapLanguageModel({ model, middleware: callTimingMiddleware(agent, options) });
}
