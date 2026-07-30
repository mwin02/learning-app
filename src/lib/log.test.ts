import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  log,
  logError,
  logWarn,
  addUsageToSnapshot,
  currentTraceId,
  recordUsage,
  serviceContext,
  takeStack,
  runWithTrace,
  traceUsageSnapshot,
  type UsageSnapshot,
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

  it('serializes Error fields to { name, message }, stack moved to `message`', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('failed', { err: new TypeError('boom') });
    const line = lastJsonLine(spy);
    expect(line.err).toEqual({ name: 'TypeError', message: 'boom' });
    expect(line.message).toContain('TypeError: boom');
  });

  it('keeps the stack inline on a non-error line (nothing lifts it)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('note', { err: new TypeError('boom') });
    const err = lastJsonLine(spy).err as Record<string, unknown>;
    expect(err.stack).toContain('TypeError: boom');
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

describe('Cloud Logging / Error Reporting fields (B1)', () => {
  it('maps level to severity on every line', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    log('a');
    logWarn('b');
    logError('c');
    expect(lastJsonLine(info).severity).toBe('INFO');
    expect(lastJsonLine(warn).severity).toBe('WARNING');
    expect(lastJsonLine(error).severity).toBe('ERROR');
  });

  it('puts the stack in `message` so Error Reporting groups on the frames', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('remediate.failed', { pathId: 'p1', err: new Error('uncoverable') });
    const line = lastJsonLine(spy);
    expect(line.message).toContain('remediate.failed: Error: uncoverable');
    expect(line.message).toContain('    at ');
    // Moved, not copied — a stack is the biggest thing in the line and Cloud
    // Logging bills by volume.
    expect(line.err).not.toHaveProperty('stack');
    expect(line.pathId).toBe('p1');
    // Frames are the grouping key; @type is only for the stack-less case.
    expect(line).not.toHaveProperty('@type');
  });

  it('falls back to @type when no field carries a stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('probe.failed', { reason: 'timeout' });
    const line = lastJsonLine(spy);
    expect(line.message).toBe('probe.failed');
    expect(line['@type']).toBe(
      'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    );
  });

  it('adds the Error Reporting fields only to error lines', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('worker.tick', { err: new Error('not an error line') });
    const line = lastJsonLine(info);
    expect(line).not.toHaveProperty('message');
    expect(line).not.toHaveProperty('serviceContext');
  });

  it('keeps the H3 fields intact alongside the new ones', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runWithTrace('t-b1', async () => {
      logError('worker.failed', { requestId: 'cr9' });
    });
    const line = lastJsonLine(spy);
    expect(line.level).toBe('error');
    expect(line.event).toBe('worker.failed');
    expect(line.traceId).toBe('t-b1');
    expect(line.requestId).toBe('cr9');
    expect(typeof line.ts).toBe('string');
  });
});

describe('takeStack', () => {
  it('finds a stack under any field name and removes it from that field', () => {
    const line = { cause: { name: 'Error', message: 'x', stack: 'Error: x\n    at f' } };
    expect(takeStack(line)).toContain('at f');
    expect(line.cause).toEqual({ name: 'Error', message: 'x' });
  });

  it('accepts a pre-serialized { stack } object (client-reported errors)', () => {
    expect(takeStack({ report: { stack: 'TypeError: e\n    at f (a.js:1:1)' } })).toContain('at f');
  });

  it('takes only the first stack, leaving a second error intact', () => {
    const line = { a: { stack: 'first\n    at f' }, b: { stack: 'second\n    at g' } };
    expect(takeStack(line)).toContain('first');
    expect(line.b.stack).toContain('second');
  });

  it('returns null when nothing carries a usable stack', () => {
    expect(takeStack({})).toBeNull();
    expect(takeStack({ a: 1, b: 'two', c: null })).toBeNull();
    expect(takeStack({ report: { stack: '' } })).toBeNull();
  });
});

describe('logError does not mutate the caller\'s objects', () => {
  it('leaves a caller-owned report object with its stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = { name: 'ClientError', message: 'boom', stack: 'ClientError: boom\n    at f' };
    logError('client.unhandled', { report });
    expect(lastJsonLine(spy).message).toContain('at f');
    expect(report.stack).toBe('ClientError: boom\n    at f');
  });
});

describe('serviceContext', () => {
  it('prefers Cloud Run K_SERVICE and includes the revision', () => {
    expect(serviceContext({ K_SERVICE: 'learning-app', K_REVISION: 'learning-app-00007-abc' })).toEqual({
      service: 'learning-app',
      version: 'learning-app-00007-abc',
    });
  });

  it('falls back to LOG_SERVICE_NAME off Cloud Run, so the worker groups separately', () => {
    expect(serviceContext({ LOG_SERVICE_NAME: 'course-worker' })).toEqual({ service: 'course-worker' });
  });

  it('defaults the service name and omits version when neither is set', () => {
    expect(serviceContext({})).toEqual({ service: 'learning-app' });
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

describe('addUsageToSnapshot (persisted cross-request accumulation)', () => {
  it('starts a snapshot from null', () => {
    const snap = addUsageToSnapshot(null, 'intake.turn', {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(snap).toEqual({
      stages: { 'intake.turn': { calls: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
      totals: { calls: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
  });

  it('folds into an existing snapshot without mutating it', () => {
    const prev: UsageSnapshot = {
      stages: { 'intake.turn': { calls: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
      totals: { calls: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
    const next = addUsageToSnapshot(prev, 'intake.turn', {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
    });
    expect(next?.stages['intake.turn']).toEqual({
      calls: 2,
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    });
    expect(next?.totals.totalTokens).toBe(180);
    expect(prev.stages['intake.turn'].calls).toBe(1); // untouched
  });

  it('recomputes totals across stages and treats missing fields as 0', () => {
    const a = addUsageToSnapshot(null, 's1', { totalTokens: 10 });
    const b = addUsageToSnapshot(a, 's2', {});
    expect(b?.totals).toEqual({ calls: 2, inputTokens: 0, outputTokens: 0, totalTokens: 10 });
  });

  it('returns prev unchanged for an undefined usage (failed call)', () => {
    const prev = addUsageToSnapshot(null, 's', { totalTokens: 1 });
    expect(addUsageToSnapshot(prev, 's', undefined)).toBe(prev);
    expect(addUsageToSnapshot(null, 's', undefined)).toBeNull();
  });
});
