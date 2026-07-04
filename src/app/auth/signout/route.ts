// Phase 3b: POST /auth/signout — clears the Supabase session cookies and lands
// on home. POST (not GET) so a prefetching link can't sign the user out; the 3e
// UI renders it as a one-button <form method="post" action="/auth/signout">.

import { NextResponse } from 'next/server';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (isSupabaseConfigured()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  // 303: browsers follow a POST redirect with GET.
  return NextResponse.redirect(new URL('/', new URL(req.url).origin), { status: 303 });
}
