// Phase 2.5j — delivery-mode classifier. Decides whether a resource's URL can be
// rendered inside an <iframe> in the learn UI, cached on `Resource.embeddable` and
// amortized across every Track built off it. The Track builder reads the cached
// value to set `LessonResource.deliveryMode` (embed vs. the safe newtab default).
//
// Two signals, in order:
//   1. Allowlist — hosts we KNOW embed, short-circuiting the network. Only YouTube
//      today: its /watch page sends `X-Frame-Options: SAMEORIGIN` (a naive probe
//      would mark it blocked), but ResourcePane rewrites watch URLs to the framable
//      /embed/ form, so it IS embeddable. The allowlist exists to express exactly
//      that "we have an embed transform for this host" override.
//   2. HEAD header probe — for everything else, fetch headers only and look for a
//      blocking frame policy (`X-Frame-Options` deny/sameorigin, or a CSP
//      `frame-ancestors` that isn't a bare `*`). No blocking header → embeddable.
//
// HEAD-only by design: we only read response headers, never the body, which keeps
// the response-size DoS surface (audit 6.4) off this code entirely.
//
// ⚠️ SSRF (audit 6.2): this fetches an arbitrary, externally-sourced URL from our
// backend — same surface as the liveness validator. When the shared outbound-fetch
// guard lands (allow http(s) only; block private/link-local IPs; re-check each
// redirect hop), route `probeFrameHeaders`'s fetch through it. Kept deliberately in
// the same shape as validators/liveness.ts so that swap is a one-liner.

import { prisma } from '@/lib/db';

const PROBE_TIMEOUT_MS = 6000;

// A real browser UA — some CDNs reject node's default UA with 403/503. Mirrors
// validators/liveness.ts; the exact string only needs to not look like a bot.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Hosts with a known embed transform in ResourcePane. Matched on registrable host
// (and subdomains): `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`.
const EMBED_ALLOWLIST = ['youtube.com', 'youtu.be'];

function hostMatchesAllowlist(host: string): boolean {
  return EMBED_ALLOWLIST.some((d) => host === d || host.endsWith('.' + d));
}

// Returns true (embeddable), false (a blocking frame header), or null (could not
// be determined — bad URL, or the probe threw/timed out). A null result is left
// un-cached so a later run retries; the builder treats null as not-embeddable.
export async function classifyEmbeddability(url: string): Promise<boolean | null> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^(www\.|m\.)/, '');
  } catch {
    return null;
  }
  if (hostMatchesAllowlist(host)) return true;
  return probeFrameHeaders(url);
}

// HEAD the URL and inspect the frame-policy headers. We can't reliably know our own
// deploy origin (Vercel preview URLs, custom domain, Cloud Run later), so any
// origin-restricting policy is treated conservatively as blocked — a wrong newtab
// is a working link, a wrong embed is a blank frame.
async function probeFrameHeaders(url: string): Promise<boolean | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    return !frameHeadersBlock(res.headers);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// True if either header forbids cross-origin framing.
//   X-Frame-Options: DENY | SAMEORIGIN  → blocked (SAMEORIGIN = the site's origin,
//     never ours).
//   CSP frame-ancestors present and not a bare `*` → blocked (any host list won't
//     include our origin, and 'none'/'self' obviously exclude us).
function frameHeadersBlock(headers: Headers): boolean {
  const xfo = headers.get('x-frame-options')?.toLowerCase() ?? '';
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return true;

  const csp = headers.get('content-security-policy')?.toLowerCase() ?? '';
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('frame-ancestors'));
  if (directive) {
    const value = directive.slice('frame-ancestors'.length).trim();
    if (value !== '*') return true;
  }
  return false;
}

// Classify one resource and persist the result. Best-effort: never throws, so a
// caller in a post-commit loop can fire-and-await it without guarding. An
// inconclusive probe (null) leaves both columns null so a later backfill retries;
// a conclusive result stamps `embedCheckedAt`. Returns the result so batch callers
// can tally it without re-reading.
export async function safeClassifyAndPersist(resourceId: string, url: string): Promise<boolean | null> {
  try {
    const embeddable = await classifyEmbeddability(url);
    if (embeddable === null) return null;
    await prisma.resource.update({
      where: { id: resourceId },
      data: { embeddable, embedCheckedAt: new Date() },
    });
    return embeddable;
  } catch (err) {
    console.log('[embeddability] classify failed', { resourceId, url, error: (err as Error).message });
    return null;
  }
}

export type BackfillEmbeddabilityResult = { embed: number; newtab: number; inconclusive: number };

// One-shot backfill of `embeddable` for the existing library (Phase 2.5j-2). Probes
// every un-probed PICKABLE resource — atomic leaves are the only rows that reach a
// Lesson (containers never do), and generated resources render inline so their
// deliveryMode is moot (and their `generated://` URL would probe inconclusive every
// run). Idempotent: targets `embedCheckedAt IS NULL`, so a re-run only retouches
// rows that stayed inconclusive. Bounded concurrency keeps the outbound HEAD fan-out
// polite. Mirrors embed-resources.ts → embedMissing() so the script stays thin.
export async function backfillEmbeddability(concurrency = 8): Promise<BackfillEmbeddabilityResult> {
  const rows = await prisma.resource.findMany({
    where: {
      embedCheckedAt: null,
      decompositionStatus: 'atomic',
      origin: { not: 'generated' },
    },
    select: { id: true, url: true },
  });

  const result: BackfillEmbeddabilityResult = { embed: 0, newtab: 0, inconclusive: 0 };
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const outcomes = await Promise.all(batch.map((r) => safeClassifyAndPersist(r.id, r.url)));
    for (const o of outcomes) {
      if (o === true) result.embed++;
      else if (o === false) result.newtab++;
      else result.inconclusive++;
    }
  }
  return result;
}
