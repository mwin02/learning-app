import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, RetryError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import {
  CallTimeoutError,
  callOutcome,
  isCallTimeoutError,
  webSearchQueryCount,
  withCallTiming,
} from '@/lib/ai/call-middleware';
import { runWithTrace, traceUsageSnapshot } from '@/lib/log';
import { runWithCompareScope, type CompareCallRecord } from '@/lib/ai/compare-scope';

const okResult: LanguageModelV3GenerateResult = {
  content: [{ type: 'text', text: 'hello' }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 7, text: 3, reasoning: 4 },
  },
  warnings: [],
};

function spies() {
  return {
    info: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

function aiCallLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => JSON.parse(String(call[0])))
    .filter((line: Record<string, unknown>) => line.event === 'ai.call');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withCallTiming', () => {
  it('logs one ok line with model id, duration and token counts, and passes the result through', async () => {
    const { info, warn, error } = spies();
    const model = withCallTiming(
      new MockLanguageModelV3({ modelId: 'gemini-mock', doGenerate: async () => okResult }),
      'mapCandidateJudge',
    );
    const result = await generateText({ model, prompt: 'hi' });
    expect(result.text).toBe('hello');

    const lines = aiCallLines(info);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      level: 'info',
      agent: 'mapCandidateJudge',
      modelId: 'gemini-mock',
      outcome: 'ok',
      inputTokens: 12,
      outputTokens: 7,
      reasoningTokens: 4,
      finishReason: 'stop',
    });
    expect(typeof line.durationMs).toBe('number');
    expect(Number(line.durationMs)).toBeGreaterThanOrEqual(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('logs one warning-level error line and rethrows the original error', async () => {
    const { info, warn, error } = spies();
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('quota exhausted');
        },
      }),
      'mapCandidateJudge',
    );
    await expect(generateText({ model, prompt: 'hi' })).rejects.toThrow('quota exhausted');

    const lines = aiCallLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      agent: 'mapCandidateJudge',
      outcome: 'error',
      error: 'quota exhausted',
    });
    expect(aiCallLines(info)).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  });

  it('reports a caller abort as aborted, not error', async () => {
    const { warn } = spies();
    const controller = new AbortController();
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: ({ abortSignal }) =>
          new Promise((_, reject) => {
            abortSignal?.addEventListener('abort', () => reject(new Error('request cancelled')));
            controller.abort();
          }),
      }),
      'mapCandidateJudge',
    );
    await expect(
      generateText({ model, prompt: 'hi', abortSignal: controller.signal }),
    ).rejects.toThrow();

    const lines = aiCallLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe('aborted');
  });

  it('records each call under ai.<agent> in the current trace', async () => {
    spies();
    const model = withCallTiming(
      new MockLanguageModelV3({ doGenerate: async () => okResult }),
      'mapCandidateJudge',
    );
    await runWithTrace('t-ai', async () => {
      await generateText({ model, prompt: 'a' });
      await generateText({ model, prompt: 'b' });
      const timing = traceUsageSnapshot()?.timings?.['ai.mapCandidateJudge'];
      expect(timing?.count).toBe(2);
      expect(timing?.totalMs).toBeGreaterThanOrEqual(timing?.maxMs ?? Infinity);
      expect(timing?.maxMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('withCallTiming — per-attempt timeout', () => {
  const TIMEOUT_MS = 20;

  // Resolves only through its signal, the way a stalled request ends once fetch is aborted.
  function hangUntilAborted(abortSignal: AbortSignal | undefined): Promise<never> {
    return new Promise((_, reject) => {
      abortSignal?.addEventListener('abort', () => reject(new Error('request cancelled')));
    });
  }

  it('retries a timed-out attempt once and returns the second result', async () => {
    const { info, warn } = spies();
    let calls = 0;
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          calls += 1;
          if (calls === 1) return hangUntilAborted(abortSignal);
          return okResult;
        },
      }),
      'conceptDeriver',
      { timeoutMs: TIMEOUT_MS },
    );
    const result = await generateText({ model, prompt: 'hi' });

    expect(result.text).toBe('hello');
    expect(calls).toBe(2);
    const lines = [...aiCallLines(warn), ...aiCallLines(info)];
    expect(lines.map((l) => l.outcome)).toEqual(['timeout', 'ok']);
  });

  it('gives up after two timed-out attempts with a CallTimeoutError naming agent and limit', async () => {
    const { warn } = spies();
    let calls = 0;
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          calls += 1;
          return hangUntilAborted(abortSignal);
        },
      }),
      'conceptDeriver',
      { timeoutMs: TIMEOUT_MS },
    );
    const err = await generateText({ model, prompt: 'hi' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CallTimeoutError);
    expect(isCallTimeoutError(err)).toBe(true);
    expect(String(err)).toContain('conceptDeriver');
    expect(String(err)).toContain(String(TIMEOUT_MS));
    expect(calls).toBe(2);
    expect(aiCallLines(warn).map((l) => l.outcome)).toEqual(['timeout', 'timeout']);
  });

  it('never retries a caller abort, and logs it as aborted', async () => {
    const { warn } = spies();
    const controller = new AbortController();
    let calls = 0;
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          calls += 1;
          const pending = hangUntilAborted(abortSignal);
          controller.abort();
          return pending;
        },
      }),
      'conceptDeriver',
      { timeoutMs: 10_000 },
    );
    const err = await generateText({
      model,
      prompt: 'hi',
      abortSignal: controller.signal,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(isCallTimeoutError(err)).toBe(false);
    expect(calls).toBe(1);
    const lines = aiCallLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe('aborted');
  });

  it('does not cut off an agent without a timeout', async () => {
    const { info } = spies();
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 3));
          expect(abortSignal?.aborted ?? false).toBe(false);
          return okResult;
        },
      }),
      'trackComposer',
    );
    const result = await generateText({ model, prompt: 'hi' });

    expect(result.text).toBe('hello');
    expect(aiCallLines(info).map((l) => l.outcome)).toEqual(['ok']);
  });
});

describe('isCallTimeoutError', () => {
  it('sees a CallTimeoutError the SDK wrapped in a RetryError', () => {
    const wrapped = new RetryError({
      message: 'Failed after 2 attempts',
      reason: 'errorNotRetryable',
      errors: [new Error('503'), new CallTimeoutError('conceptDeriver', 90_000)],
    });
    expect(isCallTimeoutError(wrapped)).toBe(true);
    expect(isCallTimeoutError(new Error('x'))).toBe(false);
  });
});

describe('callOutcome', () => {
  it('is aborted when the signal fired, whatever the error', () => {
    const controller = new AbortController();
    controller.abort();
    expect(callOutcome(new Error('x'), controller.signal)).toBe('aborted');
  });

  it('prefers the caller abort over the timeout when both fired', () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    caller.abort();
    timeout.abort();
    expect(callOutcome(new Error('x'), caller.signal, timeout.signal)).toBe('aborted');
  });

  it('is timeout when only the timeout signal fired', () => {
    const timeout = new AbortController();
    timeout.abort();
    expect(callOutcome(new Error('x'), new AbortController().signal, timeout.signal)).toBe('timeout');
  });

  it('is aborted for an AbortError without a signal', () => {
    const err = new Error('x');
    err.name = 'AbortError';
    expect(callOutcome(err, undefined)).toBe('aborted');
  });

  it('is error for a TimeoutError raised by neither signal', () => {
    const err = new Error('x');
    err.name = 'TimeoutError';
    expect(callOutcome(err, new AbortController().signal, new AbortController().signal)).toBe('error');
  });

  it('is error otherwise', () => {
    expect(callOutcome(new Error('x'), new AbortController().signal)).toBe('error');
    expect(callOutcome('string thrown', undefined)).toBe('error');
  });
});

describe('withCallTiming — compare scope sink', () => {
  function collect() {
    const records: CompareCallRecord[] = [];
    return { records, sink: (record: CompareCallRecord) => records.push(record) };
  }

  it('reports one record per ok attempt with tokens and no queries when metadata is absent', async () => {
    spies();
    const { records, sink } = collect();
    const model = withCallTiming(
      new MockLanguageModelV3({ modelId: 'gemini-mock', doGenerate: async () => okResult }),
      'mapCandidateJudge',
    );
    await runWithCompareScope({ sink }, () => generateText({ model, prompt: 'hi' }));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agent: 'mapCandidateJudge',
      modelId: 'gemini-mock',
      outcome: 'ok',
      inputTokens: 12,
      outputTokens: 7,
      reasoningTokens: 4,
      webSearchQueries: 0,
    });
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it.each(['vertex', 'google'])('counts webSearchQueries under the %s key', async (key) => {
    spies();
    const { records, sink } = collect();
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async () => ({
          ...okResult,
          providerMetadata: {
            [key]: { groundingMetadata: { webSearchQueries: ['a', 'b', 'c'] } },
          },
        }),
      }),
      'curriculumFallback',
    );
    await runWithCompareScope({ sink }, () => generateText({ model, prompt: 'hi' }));
    expect(records.map((r) => r.webSearchQueries)).toEqual([3]);
  });

  it('counts 0 when groundingMetadata has no queries', async () => {
    spies();
    const { records, sink } = collect();
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async () => ({
          ...okResult,
          providerMetadata: { vertex: { groundingMetadata: { webSearchQueries: null } } },
        }),
      }),
      'curriculumFallback',
    );
    await runWithCompareScope({ sink }, () => generateText({ model, prompt: 'hi' }));
    expect(records.map((r) => r.webSearchQueries)).toEqual([0]);
  });

  it('reports a failed attempt without tokens', async () => {
    spies();
    const { records, sink } = collect();
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('quota exhausted');
        },
      }),
      'mapCandidateJudge',
    );
    await expect(
      runWithCompareScope({ sink }, () => generateText({ model, prompt: 'hi', maxRetries: 0 })),
    ).rejects.toThrow('quota exhausted');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'error', webSearchQueries: 0 });
    expect(records[0]).not.toHaveProperty('inputTokens');
  });

  it('reports both attempts of a timed-out-then-retried call', async () => {
    spies();
    const { records, sink } = collect();
    let calls = 0;
    const model = withCallTiming(
      new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          calls += 1;
          if (calls === 1) {
            return new Promise<never>((_, reject) => {
              abortSignal?.addEventListener('abort', () => reject(new Error('request cancelled')));
            });
          }
          return okResult;
        },
      }),
      'conceptDeriver',
      { timeoutMs: 20 },
    );
    await runWithCompareScope({ sink }, () => generateText({ model, prompt: 'hi' }));
    expect(records.map((r) => r.outcome)).toEqual(['timeout', 'ok']);
  });

  it('runs and logs normally in a scope without a sink', async () => {
    const { info } = spies();
    const model = withCallTiming(
      new MockLanguageModelV3({ doGenerate: async () => okResult }),
      'mapCandidateJudge',
    );
    const result = await runWithCompareScope({}, () => generateText({ model, prompt: 'hi' }));
    expect(result.text).toBe('hello');
    expect(aiCallLines(info)).toHaveLength(1);
  });

  it('keeps the ai.call line identical with a sink present', async () => {
    const { info } = spies();
    const model = withCallTiming(
      new MockLanguageModelV3({ modelId: 'gemini-mock', doGenerate: async () => okResult }),
      'mapCandidateJudge',
    );
    await runWithCompareScope({ sink: () => {} }, () => generateText({ model, prompt: 'hi' }));
    const [line] = aiCallLines(info);
    expect(Object.keys(line)).not.toContain('webSearchQueries');
    expect(line).toMatchObject({ outcome: 'ok', inputTokens: 12, finishReason: 'stop' });
  });
});

describe('webSearchQueryCount', () => {
  it('is 0 for missing or malformed metadata', () => {
    expect(webSearchQueryCount(undefined)).toBe(0);
    expect(webSearchQueryCount({ vertex: { groundingMetadata: 'nope' } })).toBe(0);
    expect(webSearchQueryCount({ other: { groundingMetadata: { webSearchQueries: ['a'] } } })).toBe(0);
  });
});
