// Phase 3b: session refresh at the edge of every request (Next 16 renamed the
// `middleware` convention to `proxy`; Node runtime). Supabase access tokens
// expire (~1h); this is the ONE place rotated tokens get written back into
// cookies for both the browser and downstream server code — Server Components
// can't write cookies, so without this refresh, sessions would silently die.
// It does NOT gate routes: authorization stays in withAuth/withAdminAuth and
// the 3d page guards, next to the code they protect.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Auth not configured (fresh clone, CI): pass through rather than crash every
  // request — the app minus auth still works, matching withAuth's dev bypass.
  if (!url || !anonKey) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Standard @supabase/ssr dance: mutate the request cookies so code
        // later in THIS request sees the fresh token, then rebuild the response
        // so the browser receives the Set-Cookie headers.
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Validates the JWT and, when expired, refreshes the session (triggering
  // setAll above). The result is intentionally unused — refresh is the point.
  await supabase.auth.getClaims();

  return response;
}

export const config = {
  // Skip static assets; run everywhere else (pages + API) so any handler can
  // trust that a refreshable session has been refreshed.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
