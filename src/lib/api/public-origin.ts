// Free-beta D3: the origin a browser should be sent back to.
//
// `new URL(req.url).origin` is NOT it behind a proxy. Next's standalone server
// binds 0.0.0.0:8080 (see Dockerfile), and on Cloud Run that is what req.url
// reports — so an OAuth redirectTo built from it becomes
// `https://0.0.0.0:8080/auth/callback` and the sign-in dead-ends. Vercel hid
// this by rewriting req.url to the public URL; Cloud Run does not.
//
// Precedence, and why:
//   1. APP_ORIGIN — operator-declared, so it cannot be influenced by a request.
//      Set it in any environment where the public origin is knowable.
//   2. x-forwarded-host (+ x-forwarded-proto) — what the proxy says it served.
//   3. the request's own Host header.
//   4. req.url's origin — the direct-connection case (local `next start`).
//
// Steps 2–3 are attacker-influenceable in principle (host-header injection), so
// they are a convenience, not a security boundary: what actually constrains an
// OAuth return leg is Supabase's redirect allowlist, which only honors URLs
// registered in the dashboard. Setting APP_ORIGIN removes the ambiguity.

/** First value of a possibly comma-separated proxy header (`a, b` → `a`). */
function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first ? first : null;
}

function originOf(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).origin;
  } catch {
    return null;
  }
}

/**
 * Pure resolver — see the precedence list above. `fallbackOrigin` is the
 * request URL's own origin, used only when no host is discoverable.
 */
export function resolvePublicOrigin(args: {
  appOrigin?: string;
  forwardedHost: string | null;
  forwardedProto: string | null;
  host: string | null;
  fallbackOrigin: string;
}): string {
  const { appOrigin, forwardedHost, forwardedProto, host, fallbackOrigin } = args;

  if (appOrigin) {
    const declared = originOf(appOrigin);
    if (declared) return declared;
  }

  const proxiedHost = firstHeaderValue(forwardedHost) ?? firstHeaderValue(host);
  if (proxiedHost) {
    const proto = firstHeaderValue(forwardedProto) ?? 'https';
    const derived = originOf(`${proto}://${proxiedHost}`);
    if (derived) return derived;
  }

  return fallbackOrigin;
}

/** Request-level wrapper: the public origin to build browser redirects from. */
export function publicOrigin(req: Request): string {
  return resolvePublicOrigin({
    appOrigin: process.env.APP_ORIGIN,
    forwardedHost: req.headers.get('x-forwarded-host'),
    forwardedProto: req.headers.get('x-forwarded-proto'),
    host: req.headers.get('host'),
    fallbackOrigin: new URL(req.url).origin,
  });
}
