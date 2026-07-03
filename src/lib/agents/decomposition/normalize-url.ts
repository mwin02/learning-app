// F8: canonical URL for resource dedup. The Resource library keys on an exact `url`
// match (upsert-resource's findUnique + the @unique column), so trivially-different
// URLs for the same page — a tracking param, a fragment, a trailing slash, mixed host
// case — slip in as duplicate rows. Normalize before the URL-keyed upsert so those
// collapse onto one row.
//
// Pure (no DB / no imports) so it unit-tests standalone and can't drag the upsert
// module's Prisma/embedding graph into the unit project. Conservative by design: it
// only removes noise that never changes what page is served — it does NOT lowercase the
// path (case-sensitive), strip `www.`, or reorder query params (a distinct page could
// legitimately differ there). Near-duplicates with genuinely different URLs are the
// maintenance-report's job, not this.

// Well-known analytics/click params that never affect the served content.
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'igshid',
]);

export function normalizeResourceUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // Not an absolute URL (relative path / malformed) — leave it untouched rather than
    // risk mangling an identifier we don't understand.
    return trimmed;
  }

  // Scheme + host are case-insensitive; the URL parser already lowercases them and drops
  // a default port. Drop the fragment (never addresses a distinct resource for us).
  u.hash = '';

  // Strip known tracking params, preserving the order of the rest.
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }

  // Drop a trailing slash on a non-root path ("/a/b/" → "/a/b"); keep root "/".
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}
