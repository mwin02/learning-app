// Phase 3b: GET /auth/login[?next=/somewhere] — kicks off Google OAuth.
// A route handler (not a client-side call) so the PKCE code-verifier cookie is
// set server-side and sign-in works as a plain <a href="/auth/login"> with zero
// client JS — all the 3e UI needs. Supabase redirects Google back to
// /auth/callback, which finishes the exchange.

import { NextResponse } from 'next/server';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { publicOrigin } from '@/lib/api/public-origin';
import { safeNextPath } from '../safe-next';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json(
      { error: 'Auth is not configured on this deployment.', code: 'AUTH_NOT_CONFIGURED' },
      { status: 503 }
    );
  }
  const reqUrl = new URL(req.url);
  const next = safeNextPath(reqUrl.searchParams.get('next'));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // Not reqUrl.origin: behind Cloud Run that is the container's bind
      // address (0.0.0.0:8080), which Google would send the browser back to.
      redirectTo: `${publicOrigin(req)}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error || !data.url) {
    return Response.json(
      { error: 'Could not start sign-in.', code: 'OAUTH_INIT_FAILED' },
      { status: 500 }
    );
  }
  return NextResponse.redirect(data.url);
}
