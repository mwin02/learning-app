// Phase 3b: Supabase browser client, for client components that need auth state
// (the 3e sign-in UI, sign-out button). createBrowserClient memoizes internally,
// so calling this per-component is fine.
//
// NEXT_PUBLIC_* env must be referenced as literal property accesses for the
// bundler to inline them — don't refactor into the dynamic lookup server.ts uses.

'use client';

import { createBrowserClient } from '@supabase/ssr';

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Supabase auth env missing: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see .env.example).'
    );
  }
  return createBrowserClient(url, anonKey);
}
