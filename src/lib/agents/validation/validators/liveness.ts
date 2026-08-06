// Liveness validator. Cheap network check that drops URLs which don't resolve
// to a live page. Generic HTTP: a single bounded GET (the soft-404 check below
// needs the body on every 2xx, so a HEAD pre-flight would only add a round-trip
// per host without settling anything). YouTube: uses the oEmbed endpoint because
// removed videos still serve a 200 page.
//
// Soft-404s (2026-08-03): a 2xx is not proof of life. The 45 dead Khan rows found
// that day all passed this validator, and a same-day probe of the hosts in the
// library found three distinct shapes:
//
//   - answers 200 and REDIRECTS to an error page (tutorial.math.lamar.edu →
//     /Errors/PageMissing.aspx, title "Error - Page Missing") — detectable;
//   - answers 200 with a 404 page inline (title "Page not found | …") — detectable;
//   - answers 200 with a client-rendered shell that is byte-identical for a live
//     and a removed page (khanacademy.org: same ~320KB, same title "Khan Academy",
//     differing only in the echoed canonical URL) — NOT detectable server-side.
//     Its legacy APIs are 410 and its GraphQL needs a signed hash, so nothing
//     cheap distinguishes them; only a real browser render does.
//
// So this catches the first two and deliberately cannot catch the third.
//
// Failures are split by how much we trust them, because the pipeline now has a
// non-destructive outcome (validation/index.ts `quarantine`):
//
//   AUTHORITATIVE → reject, the row is dropped and never written.
//     an explicit 404/410 status, a malformed URL, a YouTube oEmbed miss. These
//     are the server telling us plainly; there is nothing for a human to add.
//
//   HEURISTIC → quarantine, the row is persisted into the review queue but kept
//     off every learner path until someone confirms it.
//     a title that looks like a 404, a redirect into an error path, and — this
//     one matters — "not reachable". The 2026-08-03 library sweep ran twice and
//     10 of the rows that failed the first pass passed the second: a 6s timeout
//     against a slow host is indistinguishable from a dead one, so treating it
//     as fatal was silently deleting live resources.
//
// That split is what lets the title patterns below be GENEROUS. Under the old
// all-or-nothing contract they had to be near-zero-false-positive, which meant
// missing real deaths; now an over-match costs a review, not a resource.

import type { Validator, ValidatorVerdict, ValidatableResource } from '../types';

const LIVENESS_TIMEOUT_MS = 6000;

// A real browser UA, because some CDNs (Cloudflare, Akamai) reject node's
// default `node` UA with 403/503. The exact string doesn't matter — what
// matters is that it doesn't look like a bot.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export const livenessValidator: Validator = {
  id: 'liveness',
  cost: 'cheap',
  async validate(rows: ValidatableResource[]): Promise<ValidatorVerdict[]> {
    return Promise.all(
      rows.map(async (r): Promise<ValidatorVerdict> => {
        const verdict = await checkLiveness(r.url);
        return verdict.alive
          ? { url: r.url, valid: true }
          : { url: r.url, valid: false, reason: verdict.reason, quarantine: verdict.quarantine };
      }),
    );
  },
};

// `alive: false` always carries the reason a reviewer will read, so a suspected
// soft-404 is distinguishable from an unreachable host both in the logs and in
// the queue. `quarantine` marks the failure as heuristic — see the header.
export type LivenessVerdict =
  | { alive: true }
  | { alive: false; reason: string; quarantine?: boolean };

const ALIVE: LivenessVerdict = { alive: true };

// Helper so every heuristic failure is flagged consistently; an authoritative one
// is written out longhand at its call site, which keeps the distinction visible.
const suspect = (reason: string): LivenessVerdict => ({ alive: false, reason, quarantine: true });

// Exported for reports R2: a learner's dead-link report re-runs exactly this
// predicate, so the auto-action and the pipeline agree on what "dead" means.
export async function checkLiveness(url: string): Promise<LivenessVerdict> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return { alive: false, reason: 'malformed url' };
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) {
    return checkYouTube(url);
  }
  return checkHttp(url);
}

// Path segments a host redirects to when it answers 200 for something missing.
// Matched against the final url's PATH + QUERY only, never the whole url — the
// scheme and host are not evidence about the page. lamar's soft-404 lands on
// /Errors/PageMissing.aspx?aspxerrorpath=<the url you asked for>, so the query
// has to stay in scope for that last pattern to fire.
const ERROR_PATH = [
  /\/errors?\//i,
  /page-?missing/i,
  /(^|\/)(404|not-?found)(\/|\.|$)/i,
  /aspxerrorpath=/i,
];

// A redirect is only evidence of death when BOTH halves hold: it lands somewhere
// error-shaped, AND it stops addressing the thing we asked for.
//
// The first half alone is not enough, because a page ABOUT an error is an ordinary
// page — MDN's /Web/HTTP/Status/404 and Next.js's /file-conventions/not-found are
// real docs that redirect (http→https, locale, a doc reshuffle) like anything else,
// and the `(404|not-?found)` pattern matches their paths exactly. Quarantining
// those would be self-inflicted: they are on-topic content for this library.
//
// The second half is what separates them from a genuine soft-404. lamar's redirect
// abandons the lesson — /Classes/CalcI/Gone.aspx → /Errors/PageMissing.aspx, where
// the thing asked for survives only as a query echo. MDN's redirect still lands on
// the page called `404`. So: if the final PATH still carries the requested url's
// last segment, the redirect moved the page, it didn't bury it.
function redirectedToError(requested: string, final: string): boolean {
  if (!final || final === requested) return false;
  let path: string;
  let pathAndQuery: string;
  try {
    const u = new URL(final);
    path = u.pathname;
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    // An unparseable final url is no evidence at all; alive is the safe direction.
    return false;
  }
  if (!ERROR_PATH.some((p) => p.test(pathAndQuery))) return false;
  return !stillAddresses(requested, path);
}

// Does `finalPath` still name what `requested` asked for? Compared on the last
// path segment, lowercased. Segments under 3 chars are ignored — "18" or "a" would
// collide with an unrelated path by accident, and a false "yes" here suppresses a
// real detection.
function stillAddresses(requested: string, finalPath: string): boolean {
  let segment: string;
  try {
    const segments = new URL(requested).pathname.split('/').filter(Boolean);
    segment = (segments.at(-1) ?? '').toLowerCase();
  } catch {
    return false;
  }
  return segment.length >= 3 && finalPath.toLowerCase().includes(segment);
}

// Titles suggesting the page is GONE, on a host that answered 200 anyway. Every
// match QUARANTINES — it never deletes — which is what lets this list be broad.
//
// The first two groups are unambiguous. The third is knowingly over-broad on the
// WORD "error": it matches real content ("Sampling and Standard Error | MIT
// OpenCourseWare", "Type I Error"), and under the old destructive contract that was
// unacceptable — an earlier cut of this validator killed exactly that OCW lecture.
// Routed to review instead, the trade inverts: catching a genuinely dead page is
// worth a reviewer glancing at a live one. Keep new patterns in the third group
// unless they cannot false-positive.
//
// The HTTP-code patterns are the exception, and deliberately are NOT over-broad. A
// bare `\b40[0-9]\b` anywhere in the title reads a COURSE NUMBER as a status code —
// "18.404 Theory of Computation", "STAT 502", "Math 401", "EE 501" — and unlike the
// "error" false positives, those don't scatter: they concentrate on numbered
// university courses, which is the exact material an OCW-heavy library is built from.
// So a code only counts in an error CONTEXT: leading the title, following an
// error/apology word, or parenthesised alone. Measured against both real dead-page
// titles and real course titles, this keeps every dead shape the loose version caught
// ("Oops! 404", "Service Unavailable (503)", "Sorry — 410" included) while dropping
// the course-number collisions.
//
// Bot-wall titles ("Client Challenge", "Just a moment") stay OUT entirely, in any
// group: a wall means we could not see the page, not that it is gone, and Khan
// serves one to our own crawler. See decomposition/page-title.ts, which keeps a
// separate list for the unrelated question of whether a title is worth storing.
const DEAD_PAGE_TITLE = [
  // Unambiguous not-found phrasing.
  /page not found/i,
  /page missing/i,
  /^\s*not found\b/i,
  /^\s*404\b/,
  /\b404\b[\s:|–—-]*(page\s+)?not found/i,
  // Strongly indicative.
  /\bnot found\b/i,
  /\bno longer (available|exists)\b/i,
  /\b(page|content) (has been )?(removed|deleted|retired)\b/i,
  /\bgone\b\s*[-–—|]/i,
  // Over-broad on purpose — quarantine-only (see above).
  /^error\b/i,
  /\berror\s*[-–—|]/i,
  // HTTP codes, error context only (see above) — never a bare number anywhere.
  /(?:^|\b(?:error|http|oops|sorry|whoops|unavailable|failed)\b\W*)(?:40[0-9]|41[0-9]|50[0-9])\b/i,
  /\(\s*(?:40[0-9]|41[0-9]|50[0-9])\s*\)/,
];

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
}

// Enough to cover <head> on every host in the library (the largest shell seen is
// ~320KB total, with <title> in the first few KB). Bounds the cost of the body
// read that the soft-404 check needs.
const TITLE_SNIFF_BYTES = 65536;

// Read at most `limit` bytes, then hang up. This is the ONLY bound on the body read:
// `Response.text()` would buffer the whole page (khanacademy.org's shell is ~320KB)
// before we threw it away, and a `Range` header can't be used to bound it either —
// see the note at the fetch call for the status corruption that causes. Cancelling
// the reader closes the connection mid-body, so the cap costs what it says.
async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let read = 0;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    // The body is deliberately unfinished; cancel releases the connection instead
    // of leaving it to drain. A cancel on an already-closed stream is not an error
    // we can act on, so it stays swallowed here rather than masking the read above.
    await reader.cancel().catch(() => {});
  }
  return out;
}

async function checkHttp(url: string): Promise<LivenessVerdict> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    // One request. There used to be a HEAD pre-flight that short-circuited a live
    // URL without reading a body, but the soft-404 check needs the body on every
    // 2xx anyway — so HEAD stopped settling anything and became a second
    // round-trip against every host we look at. Everything it could observe (the
    // status, the post-redirect url) is on this response too.
    // NO `Range` header, deliberately. It looks like the cheap way to bound the read,
    // but it CORRUPTS THE STATUS on hosts that honour it: react.dev answers a missing
    // page with 404 to a plain GET and 206 to a ranged one — the CDN serves the
    // partial body and the error status is gone. A 206 reads as alive, so an
    // authoritative 404 silently degraded into a heuristic quarantine. The read is
    // bounded by readCapped() cancelling the stream instead, which costs the same
    // bytes and keeps the status honest.
    const get = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    // Authoritative: the server stated the status outright. Nothing for a
    // reviewer to add, so this drops the row rather than queuing it.
    if (!get.ok) return { alive: false, reason: `http ${get.status}` };
    if (redirectedToError(url, get.url)) {
      return suspect(`soft 404: redirected to ${get.url}`);
    }

    // Only HTML can carry a readable 404 signature. PDFs, video and other binary
    // bodies are left alone — reading them buys nothing and costs bandwidth.
    if (!(get.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return ALIVE;

    const title = extractTitle(await readCapped(get, TITLE_SNIFF_BYTES));
    // No title, or a bot-wall/SPA-shell title, is INCONCLUSIVE — treated as alive
    // on purpose. This is the khanacademy.org case and the reason a 200 from an
    // SPA still can't be verified here.
    if (title && DEAD_PAGE_TITLE.some((p) => p.test(title))) {
      return suspect(`soft 404: page titled "${title.slice(0, 80)}"`);
    }
    return ALIVE;
  } catch {
    // Timeout / DNS / reset. Measurably NOT proof of death: re-running the
    // 2026-08-03 sweep flipped 10 of these to alive. Always quarantine.
    return suspect('url not reachable');
  } finally {
    clearTimeout(timer);
  }
}

async function checkYouTube(url: string): Promise<LivenessVerdict> {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await fetch(oembed, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    // oEmbed is authoritative for YouTube — a miss means removed/private, not a
    // heuristic guess — so it drops the row. Reaching oEmbed at all failing does not.
    return res.ok ? ALIVE : { alive: false, reason: 'youtube video unavailable' };
  } catch {
    return suspect('url not reachable');
  } finally {
    clearTimeout(timer);
  }
}
