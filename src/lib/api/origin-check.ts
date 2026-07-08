// Phase 3 hardening H2 (audit 9.7): same-origin check for state-changing
// requests, shared by withAuth and withAdminAuth. Blocks cross-site request
// forgery: a browser always attaches the Origin header to cross-origin
// mutating requests, so an off-site form/fetch riding a victim's session
// cookie arrives with a foreign Origin and is rejected. Requests with NO
// Origin header pass — CSRF requires a browser, and same-origin GET-form-free
// clients (curl, scripts, server-to-server drivers) don't send one.
//
// The allowed origin is derived from the request's own host (x-forwarded-host
// behind a proxy — Vercel sets it to the public domain — falling back to
// Host). APP_ORIGIN optionally allows one extra canonical origin, for setups
// where the public domain differs from what the proxy forwards.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    // Includes the literal "null" Origin (sandboxed iframes, some redirects):
    // not parseable as a URL, and never a legitimate same-origin request.
    return null;
  }
}

/**
 * Pure matcher: does `origin` (the Origin header value, or null if absent)
 * match the request's own host or the configured canonical origin?
 */
export function isAllowedOrigin(
  origin: string | null,
  requestHost: string | null,
  appOrigin?: string
): boolean {
  if (origin === null) return true; // non-browser client; see header comment
  const originHost = hostOf(origin);
  if (!originHost) return false;
  if (requestHost && originHost === requestHost) return true;
  if (appOrigin) {
    const allowedHost = hostOf(appOrigin.includes('://') ? appOrigin : `https://${appOrigin}`);
    if (allowedHost && originHost === allowedHost) return true;
  }
  return false;
}

/**
 * Guard for route wrappers: returns a 403 Response when a mutating request
 * carries a mismatched Origin header, null when the request may proceed.
 */
export function requireSameOrigin(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method)) return null;
  const requestHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (isAllowedOrigin(req.headers.get('origin'), requestHost, process.env.APP_ORIGIN)) {
    return null;
  }
  return Response.json(
    { error: 'Cross-origin request rejected.', code: 'BAD_ORIGIN' },
    { status: 403 }
  );
}
