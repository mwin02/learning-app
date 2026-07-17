// Audit block 4: the googleapis fetch-signal helper — every Data API fetch must
// carry a timeout, and a caller's threaded per-job abort must win when it fires
// first. Pure signal composition; no network, no env.

import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// youtube.ts transitively imports ./concepts, which pulls in @/lib/db and
// @/lib/ai/models — both validate env at module-eval; stub the leaves.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

import { googleapisFetchSignal, isoDurationToMinutes } from './youtube';

describe('googleapisFetchSignal', () => {
  it('returns a timeout signal (not yet aborted) when no parent signal is given', () => {
    const signal = googleapisFetchSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('is immediately aborted when the threaded parent signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort(new Error('job deadline exceeded'));
    const signal = googleapisFetchSignal(controller.signal);
    expect(signal.aborted).toBe(true);
  });

  it('aborts when the parent aborts after composition (deadline mid-fetch)', () => {
    const controller = new AbortController();
    const signal = googleapisFetchSignal(controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort(new Error('worker shutdown'));
    expect(signal.aborted).toBe(true);
  });
});

describe('isoDurationToMinutes', () => {
  it('converts hours/minutes/seconds and floors at 1 minute', () => {
    expect(isoDurationToMinutes('PT1H2M30S')).toBe(63);
    expect(isoDurationToMinutes('PT15M')).toBe(15);
    expect(isoDurationToMinutes('PT45S')).toBe(1);
    expect(isoDurationToMinutes('not-a-duration')).toBe(1);
  });
});
