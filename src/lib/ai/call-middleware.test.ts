import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { callOutcome, withCallTiming } from '@/lib/ai/call-middleware';
import { runWithTrace, traceUsageSnapshot } from '@/lib/log';

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

describe('callOutcome', () => {
  it('is aborted when the signal fired, whatever the error', () => {
    const controller = new AbortController();
    controller.abort();
    expect(callOutcome(new Error('x'), controller.signal)).toBe('aborted');
  });

  it.each(['AbortError', 'TimeoutError'])('is aborted for a %s without a signal', (name) => {
    const err = new Error('x');
    err.name = name;
    expect(callOutcome(err, undefined)).toBe('aborted');
  });

  it('is error otherwise', () => {
    expect(callOutcome(new Error('x'), new AbortController().signal)).toBe('error');
    expect(callOutcome('string thrown', undefined)).toBe('error');
  });
});
