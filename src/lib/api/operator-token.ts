// Free-beta E2: a bearer credential that lets the curation skills drive the
// DEPLOYED service, replacing E1's laptop-app-against-production-DB stopgap.
//
// Why a token and not a session. The operator surface is ~20 `curl` calls
// spread over the four HTTP review skills, several inside bash loops. Supabase's
// SSR session cookies are httpOnly, so "authenticate with a real session" means
// driving every one of those through a signed-in browser tab — the shape the
// skills are not written in. A token keeps the call sites as they are while
// removing the thing E1 flagged as unacceptable-as-a-standing-arrangement:
// production curation mutated with no authentication at all.
//
// What keeps it from being a standing skeleton key:
//   - It is inert unless BOTH env vars are set, so no deployment grows an auth
//     path by accident.
//   - It names a real User row rather than granting a free-floating admin, and
//     withAdminAuth still runs the same `role = 'admin'` lookup against that row
//     — so revoking the role in the DB kills the token immediately, with no
//     redeploy and no stale-JWT window. That is also what finally gives the
//     `origin: 'review'` writes an attributable principal.
//   - A short token cannot enable it. MIN_TOKEN_BYTES exists so a placeholder
//     value in a .env file (or an empty Secret Manager version) fails closed
//     instead of becoming a guessable admin credential.
//
// It does NOT weaken CSRF: requireSameOrigin runs after this, and it passes
// header-less non-browser clients by design (see origin-check.ts) — a browser
// forging a request cannot set an Authorization header cross-site anyway.

import { timingSafeEqual } from 'node:crypto';

/** 32 bytes is `openssl rand -base64 32`; anything shorter is a placeholder. */
export const MIN_TOKEN_BYTES = 32;

/** The token out of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^bearer[ \t]+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

/**
 * Constant-time compare of a presented token against the configured one.
 *
 * The early length return leaks the expected length, which is not material for
 * a random 32-byte secret and is unavoidable without hashing both sides first;
 * what matters is that two equal-length candidates take the same time, so the
 * value itself can't be walked out one byte at a time.
 */
export function tokenMatches(presented: string | null, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (b.length < MIN_TOKEN_BYTES) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Pure resolver: the User id this request authenticates as via the operator
 * token, or null if the path is unconfigured or the token doesn't match.
 *
 * The caller still has to confirm that id is an admin — this only establishes
 * *who* is asking, never that they are allowed.
 */
export function resolveOperatorPrincipal(args: {
  authorization: string | null;
  token: string | undefined;
  userId: string | undefined;
}): string | null {
  const { authorization, token, userId } = args;
  if (!userId) return null;
  if (!tokenMatches(bearerToken(authorization), token)) return null;
  return userId;
}

/** Request-level wrapper over resolveOperatorPrincipal. */
export function operatorPrincipal(req: Request): string | null {
  return resolveOperatorPrincipal({
    authorization: req.headers.get('authorization'),
    token: process.env.OPERATOR_ADMIN_TOKEN,
    userId: process.env.OPERATOR_ADMIN_USER_ID,
  });
}
