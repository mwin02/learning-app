// Phase 3b: mirror the Supabase auth identity into our User row. Runs at the
// OAuth callback — the single entry point every sign-in passes through — so
// every session is guaranteed a User row before any authed route runs, and
// withAuth never needs a per-request DB hit. Upsert (not create-if-missing)
// so a changed Google name/avatar refreshes on next sign-in.

import type { User as AuthUser } from '@supabase/supabase-js';
import { prisma } from '@/lib/db';

export type UserProfile = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

// Pure extraction, unit-testable. Google OAuth (via Supabase) puts the display
// name under user_metadata.full_name (sometimes .name) and the photo under
// .avatar_url (sometimes .picture). Returns null when there's no email — our
// User.email is NOT NULL, and an email-less identity shouldn't mint a row.
export function profileFromAuthUser(user: Pick<AuthUser, 'id' | 'email' | 'user_metadata'>): UserProfile | null {
  if (!user.email) return null;
  const meta = user.user_metadata ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    id: user.id,
    email: user.email,
    name: str(meta.full_name) ?? str(meta.name),
    avatarUrl: str(meta.avatar_url) ?? str(meta.picture),
  };
}

export async function syncUser(authUser: AuthUser): Promise<void> {
  const profile = profileFromAuthUser(authUser);
  if (!profile) return; // tolerated: the session works, the row just isn't mirrored
  const { id, ...fields } = profile;
  await prisma.user.upsert({
    where: { id },
    create: { id, ...fields },
    // role is deliberately absent here: it defaults to `user` at create and is
    // only ever changed by hand — the sync must never reset an admin.
    update: fields,
  });
}
