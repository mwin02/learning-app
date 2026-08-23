// Grounding attestation for the discovery agent.
//
// A grounded Gemini call reports which pages it actually retrieved, as
// `result.sources`. Those are NOT the pages' own URLs: each one is a
// vertexaisearch.cloud.google.com/grounding-api-redirect/… wrapper whose only
// human-readable part is the `title`, which carries a bare DOMAIN ("mit.edu").
// Resolving the wrapper — one 302, Location header, no body — yields the real
// URL Google retrieved.
//
// That resolved set is the discovery agent's candidate set. The model never
// transcribes a URL, so it cannot invent one; it only describes pages that were
// really retrieved, and web-fallback joins its descriptions back onto these URLs
// by index. This is the same guarantee doc-TOC gets from selecting out of the
// anchors it scraped (decomposition/doctoc.ts).
//
// WHY THE MODEL'S OWN URLS CANNOT BE TRUSTED, even when it did search: measured
// 2026-08-23 against a grounded prose call for "virtual memory", the model wrote
// five URLs, three of which were near-miss fabrications of pages it had actually
// retrieved — right host, right subject, wrong path (`cs3410/2019sp/…` for a page
// that lives at `cs3410/2025sp/…`). All three were 404s; the two that exactly
// matched a resolved grounding URL were live. Host-level agreement is worthless
// here — all three fabrications matched on host, which is precisely what the
// allowlist post-filter already checks.

import { logWarn } from '@/lib/log';

// The redirect service. Anything else in `sources` is not a grounding wrapper we
// know how to resolve, so it is dropped rather than passed through unresolved.
const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
const GROUNDING_REDIRECT_PATH = '/grounding-api-redirect/';

const RESOLVE_TIMEOUT_MS = 8000;
const RESOLVE_CONCURRENCY = 6;

// What the AI SDK puts in `result.sources` for a grounded call. Structurally
// typed rather than imported so this module doesn't depend on the SDK's
// generics; web-fallback passes `result.sources` straight in.
export type GroundingSource = {
  sourceType?: string;
  url?: string;
  title?: string;
};

// One page the model actually retrieved. `url` is the resolved destination —
// the only URL in this pipeline that no model ever wrote.
export type AttestedUrl = {
  url: string;
  // The domain Gemini reported for the chunk ("mit.edu"). Kept for logging: a
  // mismatch against the resolved host is worth seeing, not acting on.
  reportedDomain: string;
};

export function isGroundingRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === GROUNDING_REDIRECT_HOST && u.pathname.startsWith(GROUNDING_REDIRECT_PATH);
  } catch {
    return false;
  }
}

// Dedupe key. Trailing slash and the fragment are not part of a page's identity;
// the query IS (a lecture id often lives there), so it stays.
export function dedupeKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function dedupeAttested(rows: AttestedUrl[]): AttestedUrl[] {
  const seen = new Set<string>();
  const out: AttestedUrl[] = [];
  for (const r of rows) {
    const key = dedupeKey(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Resolve one wrapper. `redirect: 'manual'` deliberately: we want the Location
// header, not the page — following it would download every candidate's body for
// nothing, and the liveness validator fetches them properly later anyway.
async function resolveOne(source: GroundingSource): Promise<AttestedUrl | null> {
  const uri = source.url;
  if (!uri || !isGroundingRedirect(uri)) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { method: 'GET', redirect: 'manual', signal: ctl.signal });
    const location = res.headers.get('location');
    if (!location) {
      // No Location on a wrapper means the citation expired or the service
      // changed shape. Either way there is no attested URL here — dropping the
      // candidate is correct, and is strictly safer than falling back to
      // whatever the model wrote.
      logWarn('grounding.unresolved', { status: res.status, reportedDomain: source.title ?? null });
      return null;
    }
    // Relative Location would be a redirect back into the redirect service, not
    // a page; `new URL(location, uri)` would silently produce one.
    if (!/^https?:\/\//i.test(location)) {
      logWarn('grounding.non_absolute_location', { reportedDomain: source.title ?? null });
      return null;
    }
    return { url: location, reportedDomain: source.title ?? '' };
  } catch (err) {
    logWarn('grounding.resolve_failed', {
      reportedDomain: source.title ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve a grounded call's citations into the attested candidate set.
// Best-effort per source: one expired wrapper costs one candidate, never the run.
export async function resolveAttestedUrls(
  sources: GroundingSource[] | undefined,
  abortSignal?: AbortSignal,
): Promise<AttestedUrl[]> {
  const wrappers = (sources ?? []).filter((s) => s.sourceType === 'url' && s.url);
  const out: AttestedUrl[] = [];
  for (let i = 0; i < wrappers.length; i += RESOLVE_CONCURRENCY) {
    abortSignal?.throwIfAborted();
    const batch = wrappers.slice(i, i + RESOLVE_CONCURRENCY);
    const resolved = await Promise.all(batch.map(resolveOne));
    for (const r of resolved) if (r) out.push(r);
  }
  return dedupeAttested(out);
}
