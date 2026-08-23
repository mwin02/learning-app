// Unit tests for grounding attestation. Everything here is pure except
// resolveAttestedUrls, whose only I/O is one fetch per citation — stubbed.
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  isGroundingRedirect,
  dedupeKey,
  dedupeAttested,
  resolveAttestedUrls,
  type GroundingSource,
} from './grounding';

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ';

describe('isGroundingRedirect', () => {
  it('recognizes a grounding wrapper', () => {
    expect(isGroundingRedirect(`${REDIRECT}abc123==`)).toBe(true);
  });

  it('rejects an ordinary page url', () => {
    expect(isGroundingRedirect('https://ocw.mit.edu/courses/6-033/pages/week-1')).toBe(false);
  });

  it('rejects a lookalike host', () => {
    expect(isGroundingRedirect('https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/x')).toBe(false);
  });

  it('rejects the right host on the wrong path', () => {
    expect(isGroundingRedirect('https://vertexaisearch.cloud.google.com/search?q=x')).toBe(false);
  });

  it('rejects an unparseable url', () => {
    expect(isGroundingRedirect('not a url')).toBe(false);
  });
});

describe('dedupeKey', () => {
  it('ignores the fragment', () => {
    expect(dedupeKey('https://example.test/a#intro')).toBe(dedupeKey('https://example.test/a'));
  });

  it('ignores a trailing slash', () => {
    expect(dedupeKey('https://example.test/a/')).toBe(dedupeKey('https://example.test/a'));
  });

  it('keeps the query — a lecture id often lives there', () => {
    expect(dedupeKey('https://example.test/a?lec=7')).not.toBe(dedupeKey('https://example.test/a?lec=8'));
  });

  it('does not collapse the root path to empty', () => {
    expect(dedupeKey('https://example.test/')).toBe('https://example.test/');
  });

  it('falls back to the raw string for an unparseable url', () => {
    expect(dedupeKey('NOT A URL')).toBe('not a url');
  });
});

describe('dedupeAttested', () => {
  it('collapses trailing-slash and fragment variants, keeping the first', () => {
    const out = dedupeAttested([
      { url: 'https://example.test/a', reportedDomain: 'example.test' },
      { url: 'https://example.test/a/', reportedDomain: 'other.test' },
      { url: 'https://example.test/a#x', reportedDomain: 'other.test' },
      { url: 'https://example.test/b', reportedDomain: 'example.test' },
    ]);
    expect(out.map((r) => r.url)).toEqual(['https://example.test/a', 'https://example.test/b']);
    expect(out[0].reportedDomain).toBe('example.test');
  });
});

describe('resolveAttestedUrls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(byUrl: Record<string, { status: number; location?: string }>) {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      void init;
      const key = String(input);
      const hit = byUrl[key];
      if (!hit) throw new Error(`unexpected fetch: ${key}`);
      return {
        status: hit.status,
        headers: { get: (h: string) => (h.toLowerCase() === 'location' ? (hit.location ?? null) : null) },
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const source = (url: string, title = 'example.test'): GroundingSource => ({
    sourceType: 'url',
    url,
    title,
  });

  it('resolves each wrapper to the page named in its Location header', async () => {
    stubFetch({
      [`${REDIRECT}one`]: { status: 302, location: 'https://ocw.mit.edu/courses/6-004/pages/c7' },
      [`${REDIRECT}two`]: { status: 302, location: 'https://docs.python.org/3/tutorial/' },
    });

    const out = await resolveAttestedUrls([source(`${REDIRECT}one`, 'mit.edu'), source(`${REDIRECT}two`, 'python.org')]);

    expect(out).toEqual([
      { url: 'https://ocw.mit.edu/courses/6-004/pages/c7', reportedDomain: 'mit.edu' },
      { url: 'https://docs.python.org/3/tutorial/', reportedDomain: 'python.org' },
    ]);
  });

  it('does NOT follow the redirect — the body is never fetched', async () => {
    const fetchMock = stubFetch({
      [`${REDIRECT}one`]: { status: 302, location: 'https://ocw.mit.edu/x' },
    });

    await resolveAttestedUrls([source(`${REDIRECT}one`)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('drops a wrapper with no Location rather than falling back to anything', async () => {
    stubFetch({ [`${REDIRECT}gone`]: { status: 404 } });
    expect(await resolveAttestedUrls([source(`${REDIRECT}gone`)])).toEqual([]);
  });

  it('drops a relative Location — that redirects back into the service, not to a page', async () => {
    stubFetch({ [`${REDIRECT}rel`]: { status: 302, location: '/grounding-api-redirect/again' } });
    expect(await resolveAttestedUrls([source(`${REDIRECT}rel`)])).toEqual([]);
  });

  it('drops a source that is not a grounding wrapper', async () => {
    stubFetch({});
    expect(await resolveAttestedUrls([source('https://ocw.mit.edu/courses/6-033')])).toEqual([]);
  });

  it('drops a non-url source type', async () => {
    stubFetch({});
    expect(await resolveAttestedUrls([{ sourceType: 'document', url: `${REDIRECT}doc` }])).toEqual([]);
  });

  it('survives a fetch that throws, losing only that candidate', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith('bad')) throw new Error('ECONNRESET');
      return {
        status: 302,
        headers: { get: () => 'https://example.test/good' },
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveAttestedUrls([source(`${REDIRECT}bad`), source(`${REDIRECT}good`)]);

    expect(out.map((r) => r.url)).toEqual(['https://example.test/good']);
  });

  it('dedupes two citations that resolve to the same page', async () => {
    stubFetch({
      [`${REDIRECT}one`]: { status: 302, location: 'https://example.test/a' },
      [`${REDIRECT}two`]: { status: 302, location: 'https://example.test/a/' },
    });

    const out = await resolveAttestedUrls([source(`${REDIRECT}one`), source(`${REDIRECT}two`)]);

    expect(out).toHaveLength(1);
  });

  it('returns nothing when the call produced no citations at all (the JSON-mode failure)', async () => {
    stubFetch({});
    expect(await resolveAttestedUrls(undefined)).toEqual([]);
    expect(await resolveAttestedUrls([])).toEqual([]);
  });
});
