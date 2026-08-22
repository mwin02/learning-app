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

// Minimal Response stand-in: the validator reads ok/status/url/headers and streams
// `body`. A real ReadableStream, not a `text()` shim — the validator caps its read
// by cancelling the reader, so a stub that can't be cancelled wouldn't exercise it.
function reply({ status = 200, url = '', contentType = 'text/html; charset=utf-8', body = '' }: Reply) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

type Sent = { method: string; headers: Record<string, string> };

// `replies` is keyed by method. Only GET is ever expected — a HEAD arriving here is
// a regression (the pre-flight was removed) — and `sent` records what went out, so
// a test can assert on the request itself and not just the verdict.
function stubFetch(replies: { HEAD?: Reply | 'throw'; GET?: Reply | 'throw' }): { sent: Sent[] } {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const method = init?.method ?? 'GET';
      sent.push({ method, headers: init?.headers ?? {} });
      const r = replies[method as 'HEAD' | 'GET'];
      if (r === 'throw') throw new Error('connection reset');
      if (!r) throw new Error(`no stubbed reply for ${method}`);
      return reply({ url: input, ...r });
    },
  );
  return { sent };
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

  // Deliberate over-match on the WORD "error". These are REAL page titles and the
  // loose pattern does fire on them — acceptable only because the outcome is a
  // review, not a deletion. An earlier destructive cut of this validator killed the
  // OCW lecture below for real, which is why this asymmetry is pinned by a test.
  it.each([
    'Lecture 8: Sampling and Standard Error | MIT OpenCourseWare',
    'Type I Error vs Type II Error | Statistics',
  ])('quarantines rather than rejects the false positive %j', async (title) => {
    stubFetch({ HEAD: {}, GET: { body: page(title) } });
    expect(await outcome(URL_)).toBe('quarantine');
  });

  // HTTP codes still count when the title is error-SHAPED, including the forms that
  // carry no "error"/"http" word at all — those are the shapes a position-anchored
  // pattern would miss.
  it.each([
    '500 Internal Server Error',
    '503 Service Temporarily Unavailable',
    'HTTP 502 Bad Gateway',
    '403 Forbidden',
    'Oops! 404',
    'Service Unavailable (503)',
    'Sorry — 410',
  ])('quarantines an http-code title %j', async (title) => {
    stubFetch({ GET: { body: page(title) } });
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

// The failure mode that made the numeric pattern worth narrowing: a course number
// is not a status code, and unlike the "error"-word false positives these do not
// scatter — they land on numbered university courses, which is most of what an
// OCW-heavy library indexes.
describe('livenessValidator — a course number is not an http status', () => {
  it.each([
    '18.404 Theory of Computation | MIT OpenCourseWare',
    'STAT 502: Analysis of Variance',
    'Math 401: Introduction to Real Analysis',
    'CS 405 — Computer Graphics',
    'PHYS 401 Quantum Mechanics I',
    'EE 501 Linear Systems Theory',
    'Chapter 405: Dynamic Programming',
    'Statistics 401 (Fall 2005)',
    'Introduction to Probability (6.041)',
  ])('keeps %j alive', async (title) => {
    stubFetch({ GET: { body: page(title) } });
    expect(await outcome(URL_)).toBe('alive');
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

  // ocw.mit.edu's answer to a path that does not exist: `/x` → `/x/` →
  // `/x/index.html` → `/x/`, until fetch() gives up and throws. Indistinguishable
  // from an unreachable host at the catch site, which is how 52 fabricated OCW
  // URLs reached the library on 2026-08-21 — quarantined for review instead of
  // dropped, because OCW never answers a bad path with a 404.
  it('rejects a redirect loop — the host answered, the url just names nothing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('redirect count exceeded'),
      });
    });
    const url = 'https://ocw.mit.edu/courses/18-650/resources/lecture-20-invented';
    expect(await outcome(url)).toBe('reject');
    const v = await check(url);
    expect(v.valid === false && v.reason).toBe('redirect loop');
  });

  // The narrowness above is the point: a throw with any other cause is still the
  // slow-host case, and must keep its quarantine.
  it('still quarantines a throw that is not a redirect loop', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
    });
    expect(await outcome('https://slow.example.edu/x')).toBe('quarantine');
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

  it('keeps a redirect onto a page that is ABOUT an error but still the page asked for', async () => {
    // The `(404|not-?found)` path pattern matches these exactly, and they are real
    // docs this library would source. What saves them is that the redirect still
    // lands on the requested last segment — it moved the page, it didn't bury it.
    // Titles here are deliberately clean: the title heuristic is a SEPARATE gate,
    // and MDN's real title would trip it on its own. This pins the redirect check.
    const mdn = 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404';
    stubFetch({ GET: { url: mdn, body: page('HTTP response status codes | MDN') } });
    expect(await outcome('http://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404')).toBe('alive');

    const next = 'https://nextjs.org/docs/app/api-reference/file-conventions/not-found';
    stubFetch({ GET: { url: next, body: page('File conventions: not-found | Next.js') } });
    expect(await outcome('https://nextjs.org/docs/api-reference/file-conventions/not-found')).toBe('alive');
  });

  // Guards the removal of the HEAD pre-flight: the soft-404 check needs the body on
  // every 2xx, so HEAD settled nothing and cost a round-trip against every host.
  it('issues exactly one request, and never a HEAD', async () => {
    const { sent } = stubFetch({ GET: { body: page('Real Lesson') } });
    expect(await outcome('https://example.com/lesson')).toBe('alive');
    expect(sent.map((s) => s.method)).toEqual(['GET']);
  });

  // Regression guard, and NOT a style preference. `Range: bytes=0-N` looks like the
  // obvious way to bound the read, but hosts that honour it answer a missing page
  // with 206 instead of 404 (react.dev does exactly this behind its CDN) — which
  // reads as alive here and downgrades an authoritative reject into a quarantine.
  // The read is bounded by cancelling the stream instead; see liveness.ts.
  it('sends no Range header, so an authoritative status is never masked by a 206', async () => {
    const { sent } = stubFetch({ GET: { body: page('Real Lesson') } });
    await outcome('https://example.com/lesson');
    const headers = Object.fromEntries(
      Object.entries(sent[0].headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers).not.toHaveProperty('range');
  });
});
