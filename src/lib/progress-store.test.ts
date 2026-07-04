// Unit tests for the progress-store seam (Phase 2.6 local + Phase 3f DB).
// Pure client logic: localStorage and fetch are stubbed in-memory — no DB, no
// network. The route/DB half lives in tests/integration/track-progress.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressStore, migrateLocalToDb } from './progress-store';

const TRACK = 'trk_test';
const KEY = `learn:progress:${TRACK}`;

let storage: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

// What the fetch stub answers with, per method. Overridden per test.
let responses: Record<string, { ok: boolean; body?: unknown }>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  responses = {
    GET: { ok: true, body: { lessonIds: [] } },
    PUT: { ok: true, body: { ok: true } },
    POST: { ok: true, body: { migrated: 0 } },
  };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const r = responses[init?.method ?? 'GET'];
    return { ok: r.ok, json: async () => r.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LocalProgressStore (anonymous / dev bypass)', () => {
  it('round-trips setComplete through localStorage without touching the network', async () => {
    const store = createProgressStore(TRACK); // signedIn defaults to false
    await store.setComplete('l1', true);
    await store.setComplete('l2', true);
    await store.setComplete('l1', false);
    expect([...(await store.load())]).toEqual(['l2']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades corrupt localStorage to an empty set', async () => {
    storage.set(KEY, 'not json{');
    expect((await createProgressStore(TRACK).load()).size).toBe(0);
  });
});

describe('DbProgressStore (signed in)', () => {
  it('load() reads completed lessonIds from the API', async () => {
    responses.GET = { ok: true, body: { lessonIds: ['a', 'b'] } };
    const set = await createProgressStore(TRACK, true).load();
    expect(set).toEqual(new Set(['a', 'b']));
    expect(fetchMock).toHaveBeenCalledWith(`/api/progress/${TRACK}`);
  });

  it('load() degrades to empty on a non-OK response and on a network error', async () => {
    responses.GET = { ok: false };
    expect((await createProgressStore(TRACK, true).load()).size).toBe(0);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect((await createProgressStore(TRACK, true).load()).size).toBe(0);
  });

  it('setComplete() PUTs the single-lesson change', async () => {
    await createProgressStore(TRACK, true).setComplete('l9', true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/progress/${TRACK}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ lessonId: 'l9', complete: true });
  });

  it('setComplete() swallows network failures (optimistic UI already updated)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(createProgressStore(TRACK, true).setComplete('l1', true)).resolves.toBeUndefined();
  });
});

describe('migrateLocalToDb', () => {
  it('is a no-op (no fetch) when there is no local progress', async () => {
    await migrateLocalToDb(TRACK);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bulk-POSTs local lessonIds and clears the key on success', async () => {
    storage.set(KEY, JSON.stringify(['a', 'b']));
    await migrateLocalToDb(TRACK);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/progress/${TRACK}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ lessonIds: ['a', 'b'] });
    expect(storage.has(KEY)).toBe(false);
  });

  it('keeps the local key when the push fails (non-OK or network error)', async () => {
    storage.set(KEY, JSON.stringify(['a']));
    responses.POST = { ok: false };
    await migrateLocalToDb(TRACK);
    expect(storage.get(KEY)).toBe(JSON.stringify(['a']));

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await migrateLocalToDb(TRACK);
    expect(storage.get(KEY)).toBe(JSON.stringify(['a']));
  });

  it('runs inside DbProgressStore.load() before the read', async () => {
    storage.set(KEY, JSON.stringify(['a']));
    responses.GET = { ok: true, body: { lessonIds: ['a'] } };
    const set = await createProgressStore(TRACK, true).load();
    expect(set).toEqual(new Set(['a']));
    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit)?.method ?? 'GET');
    expect(methods).toEqual(['POST', 'GET']); // migrate first, then read
    expect(storage.has(KEY)).toBe(false);
  });
});
