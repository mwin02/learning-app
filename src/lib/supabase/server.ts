// Phase 3b: Supabase server client (App Router). One client per request scope —
// route handlers, server components, and the auth wrappers all create their own
// via this helper; @supabase/ssr keeps the session in cookies, so there is no
// shared/global client (unlike src/lib/db.ts's prisma singleton).
//
// Env is validated lazily (not at module eval) on purpose: unit tests and
// no-auth local dev import route modules that transitively pull this in, and the
// module-eval-throw pattern in @/lib/db is exactly what CLAUDE.md warns needs
// vi.mock stubs. Callers that can run without auth (withAuth's dev bypass, the
// proxy) check isSupabaseConfigured() first.

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export function supabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export function isSupabaseConfigured(): boolean {
  return supabaseEnv() !== null;
}

export async function createSupabaseServerClient() {
  const env = supabaseEnv();
  if (!env) {
    throw new Error(
      'Supabase auth env missing: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see .env.example).'
    );
  }
  const cookieStore = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components can't write cookies. Safe to swallow: the proxy
          // (src/proxy.ts) refreshes sessions and persists rotated tokens.
        }
      },
    },
  });
}
