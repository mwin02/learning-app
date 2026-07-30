// Phase 3b: GET /auth/callback?code=…&next=… — the OAuth return leg. Exchanges
// the auth code for a session (cookies written via the server client), mirrors
// the identity into our User row (see user-sync.ts — this is the one entry
// point every sign-in passes through), then redirects to the sanitized `next`.
// Failures land back on home with ?auth_error=1 rather than a dead JSON page —
// there's no error UI yet (3e at the earliest).

import { NextResponse } from 'next/server';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { syncUser } from '@/lib/auth/user-sync';
import { publicOrigin } from '@/lib/api/public-origin';
import { safeNextPath } from '../safe-next';
import { logError } from '@/lib/log';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const reqUrl = new URL(req.url);
  const code = reqUrl.searchParams.get('code');
  const next = safeNextPath(reqUrl.searchParams.get('next'));
  // Behind a proxy, reqUrl.origin is the container's bind address — every
  // redirect below must use the public one or the browser lands nowhere.
  const origin = publicOrigin(req);

  if (!code || !isSupabaseConfigured()) {
    return NextResponse.redirect(new URL('/?auth_error=1', origin));
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    logError('auth-callback.code-exchange-failed', { message: error?.message });
    return NextResponse.redirect(new URL('/?auth_error=1', origin));
  }

  try {
    await syncUser(data.user);
  } catch (err) {
    // Session is live but the mirror row failed (DB blip). Log loudly and let
    // the user in — withAuth works off the JWT, and the next sign-in re-syncs.
    logError('auth-callback.user-sync-failed', { err });
  }

  return NextResponse.redirect(new URL(next, origin));
}
