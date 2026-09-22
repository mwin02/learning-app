'use client';

// TopNav is rendered by the ROOT LAYOUT, and Next's partial rendering never
// re-runs a shared layout during a client-side transition — so a session that
// ends (or begins) while the tab sits open leaves the header frozen on the auth
// state of the last full document load. The symptom was a signed-out /signin
// page rendered under a header still showing the avatar and the Programs link,
// correct again only after a manual reload.
//
// This leaf watches the browser's own view of the session and calls
// router.refresh() when it disagrees with what the server rendered. refresh()
// refetches the whole tree, layouts included, so the header self-corrects in
// both directions — expiry here, and sign-in from another tab.
//
// Presence only: TOKEN_REFRESHED fires on every rotation and must not trigger a
// refetch, so the token itself is never compared.

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { decideAuthSync } from './auth-sync';

export function AuthStateSync({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const actedOn = useRef<boolean | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    // Subscribing emits INITIAL_SESSION with the persisted session, which is
    // the mount-time comparison — no separate getSession() call needed.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const decision = decideAuthSync(actedOn.current, signedIn, session != null);
      actedOn.current = decision.actedOn;
      if (decision.refresh) router.refresh();
    });
    return () => data.subscription.unsubscribe();
  }, [router, signedIn]);

  return null;
}
