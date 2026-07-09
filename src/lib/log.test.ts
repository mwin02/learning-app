import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  log,
  logError,
  logWarn,
  currentTraceId,
  recordUsage,
  runWithTrace,
  traceUsageSnapshot,
} from '@/lib/log';

afterEach(() => {
  vi.restoreAllMocks();
});

function lastJsonLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  return JSON.parse(call![0] as string);
}

describe('log helpers', () => {
  it('emits one JSON line with ts, level, event and fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('worker.processing', { id: 'cr1', topic: 'calculus' });
    const line = lastJsonLine(spy);
    expect(line.level).toBe('info');
    expect(line.event).toBe('worker.processing');
    expect(line.id).toBe('cr1');
    expect(line.topic).toBe('calculus');
    expect(typeof line.ts).toBe('string');
  });

  it('routes warn/error to console.warn/console.error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logWarn('a');
    logError('b');
    expect(lastJsonLine(warn).level).toBe('warn');
    expect(lastJsonLine(error).level).toBe('error');
  });

  it('serializes Error fields to { name, message }', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('failed', { err: new TypeError('boom') });
    expect(lastJsonLine(spy).err).toEqual({ name: 'TypeError', message: 'boom' });
  });

  it('omits traceId outside a trace, includes it inside', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('outside');
    expect(lastJsonLine(spy)).not.toHaveProperty('traceId');
    await runWithTrace('t-123', async () => {
      log('inside');
    });
    expect(lastJsonLine(spy).traceId).toBe('t-123');
  });
});

describe('trace usage accounting', () => {
  it('currentTraceId is null outside, set inside, restored after', async () => {
    expect(currentTraceId()).toBeNull();
    await runWithTrace('t-1', async () => {
      expect(currentTraceId()).toBe('t-1');
    });
    expect(currentTraceId()).toBeNull();
  });

  it('recordUsage outside a trace is a no-op and snapshot is null', () => {
    recordUsage('plan.decompose', { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(traceUsageSnapshot()).toBeNull();
  });

  it('snapshot is null inside a trace when nothing was recorded', async () => {
    await runWithTrace('t-empty', async () => {
      expect(traceUsageSnapshot()).toBeNull();
    });
  });

  it('accumulates per-stage usage and totals across calls', async () => {
    await runWithTrace('t-2', async () => {
      recordUsage('plan.decompose', { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      recordUsage('plan.gate', { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
      recordUsage('plan.gate', { inputTokens: 20, outputTokens: 3, totalTokens: 23 });
      expect(traceUsageSnapshot()).toEqual({
        stages: {
          'plan.decompose': { calls: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          'plan.gate': { calls: 2, inputTokens: 30, outputTokens: 5, totalTokens: 35 },
        },
        totals: { calls: 3, inputTokens: 130, outputTokens: 55, totalTokens: 185 },
      });
    });
  });

  it('treats missing token fields as 0 but still counts the call', async () => {
    await runWithTrace('t-3', async () => {
      recordUsage('stage', {});
      recordUsage('stage', undefined); // failed call — ignored entirely
      expect(traceUsageSnapshot()).toEqual({
        stages: { stage: { calls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        totals: { calls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
    });
  });

  it('usage recorded deep in the async call graph lands in the trace', async () => {
    async function deepAiCall() {
      await Promise.resolve();
      recordUsage('deep.stage', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    }
    await runWithTrace('t-4', async () => {
      await Promise.all([deepAiCall(), deepAiCall()]);
      expect(traceUsageSnapshot()?.stages['deep.stage'].calls).toBe(2);
    });
  });

  it('concurrent traces do not bleed into each other', async () => {
    const snapshots: Record<string, number> = {};
    await Promise.all([
      runWithTrace('a', async () => {
        recordUsage('s', { totalTokens: 1 });
        await new Promise((r) => setTimeout(r, 5));
        snapshots.a = traceUsageSnapshot()!.totals.totalTokens;
      }),
      runWithTrace('b', async () => {
        recordUsage('s', { totalTokens: 100 });
        snapshots.b = traceUsageSnapshot()!.totals.totalTokens;
      }),
    ]);
    expect(snapshots).toEqual({ a: 1, b: 100 });
  });
});
