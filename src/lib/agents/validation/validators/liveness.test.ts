// Liveness gating. The cases here are the real response shapes found when probing
// every host in the library on 2026-08-03 — see the header comment in liveness.ts.
//
// The contract has THREE outcomes, and most of these tests exist to pin the
// boundary between them:
//   alive      — passes through and gets attached.
//   quarantine — persisted into the review queue, never attached. Used for every
//                heuristic failure, so a wrong guess costs a review, not a resource.
//   reject     — dropped outright. Only for authoritative failures.
// The load-bearing assertions are that khanacademy.org's shell and a bot-wall stay
// ALIVE, and that heuristics quarantine rather than reject.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { livenessValidator } from '@/lib/agents/validation/validators/liveness';

type Reply = { status?: number; url?: string; contentType?: string; body?: string };

// Minimal Response stand-in: the validator reads ok/status/url/headers/text only.
function reply({ status = 200, url = '', contentType = 'text/html; charset=utf-8', body = '' }: Reply) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

// `replies` is keyed by method so a test can give HEAD and GET different answers.
function stubFetch(replies: { HEAD?: Reply | 'throw'; GET?: Reply | 'throw' }) {
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const r = replies[method as 'HEAD' | 'GET'];
    if (r === 'throw') throw new Error('connection reset');
    if (!r) throw new Error(`no stubbed reply for ${method}`);
    return reply({ url: input, ...r });
  });
}

async function check(url: string) {
  const [verdict] = await livenessValidator.validate([{ url, title: 't', summary: 's', type: 'article' }]);
  return verdict;
}

// Collapsing quarantine and reject in assertions would hide the whole point of
// the validator, so outcomes are always compared three-ways.
async function outcome(url: string): Promise<'alive' | 'quarantine' | 'reject'> {
  const v = await check(url);
  if (v.valid) return 'alive';
  return v.quarantine ? 'quarantine' : 'reject';
}

const page = (title: string) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>x</body></html>`;
const URL_ = 'https://example.edu/lecture';

afterEach(() => vi.unstubAllGlobals());

describe('livenessValidator — heuristic failures quarantine, never reject', () => {
  it('quarantines a 200 that redirected to an error page (lamar)', async () => {
    const dead = 'https://tutorial.math.lamar.edu/Classes/CalcI/Gone.aspx';
    const errorPage = 'https://tutorial.math.lamar.edu/Errors/PageMissing.aspx?aspxerrorpath=/Classes/CalcI/Gone.aspx';
    stubFetch({ HEAD: { url: errorPage }, GET: { url: errorPage } });
    expect(await outcome(dead)).toBe('quarantine');
    const v = await check(dead);
    expect(v.valid === false && v.reason).toMatch(/soft 404/);
  });

  it.each([
    'Error - Page Missing',
    'Page not found | Khan Academy',
    'Not Found – React',
    '404: Not Found',
    '404 | This page could not be found',
    'This content has been removed',
    'Page no longer available',
  ])('quarantines a page titled %j', async (title) => {
    stubFetch({ HEAD: {}, GET: { body: page(title) } });
    expect(await outcome(URL_)).toBe('quarantine');
  });

  // Deliberate over-match. These are REAL page titles, and the loosened patterns
  // do fire on them — which is only acceptable because the outcome is a review,
  // not a deletion. An earlier destructive cut of this validator killed the OCW
  // lecture below for real, which is why this asymmetry is pinned by a test.
  it.each([
    'Lecture 8: Sampling and Standard Error | MIT OpenCourseWare',
    'Type I Error vs Type II Error | Statistics',
    'STAT 502: Analysis of Variance',
  ])('quarantines rather than rejects the false positive %j', async (title) => {
    stubFetch({ HEAD: {}, GET: { body: page(title) } });
    expect(await outcome(URL_)).toBe('quarantine');
  });

  it('quarantines an unreachable host — a timeout is not proof of death', async () => {
    // Re-running the 2026-08-03 sweep flipped 10 of these to alive.
    stubFetch({ HEAD: 'throw', GET: 'throw' });
    expect(await outcome('https://slow.example.edu/x')).toBe('quarantine');
    const v = await check('https://slow.example.edu/x');
    expect(v.valid === false && v.reason).toBe('url not reachable');
  });
});

describe('livenessValidator — authoritative failures reject', () => {
  it('rejects an explicit 404 status', async () => {
    stubFetch({ HEAD: { status: 404 }, GET: { status: 404, body: page('Not Found – React') } });
    expect(await outcome('https://react.dev/learn/nope')).toBe('reject');
    const v = await check('https://react.dev/learn/nope');
    expect(v.valid === false && v.reason).toBe('http 404');
  });

  it('rejects a 410 Gone', async () => {
    stubFetch({ HEAD: { status: 410 }, GET: { status: 410, body: page('Gone') } });
    expect(await outcome('https://example.edu/retired')).toBe('reject');
  });

  it('rejects a malformed url without touching the network', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('should not be called'); });
    expect(await outcome('not-a-url')).toBe('reject');
  });

  it('rejects a YouTube video whose oEmbed says it is gone', async () => {
    vi.stubGlobal('fetch', async () => reply({ status: 404 }));
    const v = await check('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    expect(v.valid).toBe(false);
    expect(v.valid === false && v.quarantine).toBeFalsy();
    expect(v.valid === false && v.reason).toBe('youtube video unavailable');
  });
});

describe('livenessValidator — ambiguity means alive', () => {
  it("keeps khanacademy.org's SPA shell, which is identical for live and dead pages", async () => {
    stubFetch({ HEAD: {}, GET: { body: page('Khan Academy') } });
    expect(await outcome('https://www.khanacademy.org/math/linear-algebra/vectors-and-spaces')).toBe('alive');
  });

  it.each(['Client Challenge', 'Just a moment...', 'Attention Required!'])(
    'keeps a bot-walled page titled %j — a wall is not a death certificate',
    async (title) => {
      stubFetch({ HEAD: {}, GET: { body: page(title) } });
      expect(await outcome('https://www.khanacademy.org/math/anything')).toBe('alive');
    },
  );

  it('keeps a page with no <title> at all', async () => {
    stubFetch({ HEAD: {}, GET: { body: '<html><body>content</body></html>' } });
    expect(await outcome('https://example.com/untitled')).toBe('alive');
  });

  it('keeps a plain redirect that is not error-shaped', async () => {
    const dest = 'https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/';
    stubFetch({ HEAD: { url: dest }, GET: { url: dest, body: page('Linear Algebra | MIT OpenCourseWare') } });
    expect(await outcome('http://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010')).toBe('alive');
  });

  it('does not read a non-HTML body, so a PDF can never soft-404 itself', async () => {
    stubFetch({ HEAD: {}, GET: { contentType: 'application/pdf', body: 'Error - not a real title' } });
    expect(await outcome('https://example.edu/notes.pdf')).toBe('alive');
  });

  it('still passes when HEAD throws but GET succeeds', async () => {
    stubFetch({ HEAD: 'throw', GET: { body: page('Real Lesson') } });
    expect(await outcome('https://example.com/head-hostile')).toBe('alive');
  });
});
