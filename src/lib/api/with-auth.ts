// Phase 3b: real session auth. Wraps an App Router handler; the handler
// receives a Session whose userId is the Supabase auth user id (which is also
// our User.id — see the 3a schema note). Routes written against the Phase-2d
// placeholder did not change: only this file did, as designed.
//
// Order of checks:
//   1. Real Supabase session (JWT from cookies, verified via getClaims).
//   2. Dev bypass: NODE_ENV=development AND DEV_AUTH=1 → session with a null
//      userId, so local/scripted testing works without OAuth setup. Dead in
//      production builds by construction. Goes away once we trust the real flow.
//   3. Otherwise 401 JSON.
//
// userId stays `string | null` in the type solely because of the dev bypass;
// real sessions always carry a non-null id. 3c tightens routes that must have
// an owner (limits/enrollment) to reject null explicitly.

import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';

export type Session = {
  userId: string | null;
};

// Phase 3c: `ctx` is Next's second route-handler argument (holds `params` for
// dynamic routes), passed through untouched so wrapped dynamic routes (e.g.
// /api/programs/[programId]/enroll) can read their params. Static routes ignore it.
export type AuthedHandler<C = unknown> = (
  req: Request,
  session: Session,
  ctx: C
) => Promise<Response> | Response;

function devBypass(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.DEV_AUTH === '1';
}

export async function getSessionUserId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return data.claims.sub;
}

export function withAuth<C = unknown>(handler: AuthedHandler<C>): (req: Request, ctx: C) => Promise<Response> {
  return async (req: Request, ctx: C) => {
    const userId = await getSessionUserId();
    if (userId) return handler(req, { userId }, ctx);
    if (devBypass()) return handler(req, { userId: null }, ctx);
    return Response.json({ error: 'Sign in required.', code: 'UNAUTHENTICATED' }, { status: 401 });
  };
}
