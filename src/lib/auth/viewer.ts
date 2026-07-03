// Phase 3d: page-side access checks (server components). The API wrappers
// (withAuth / withAdminAuth) gate routes; these gate PAGES, sharing the same
// primitives. Everything request-scoped is wrapped in React cache() so a layout
// + its page + generateMetadata asking the same question costs one lookup.

import { cache } from 'react';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/api/with-auth';
import { isAdmin } from '@/lib/api/with-admin-auth';
import { isDevAuthEnabled } from '@/lib/dev-auth';

export type Viewer = {
  userId: string | null;
  isAdmin: boolean;
};

// The dev bypass (local only — isDevAuthEnabled is dead outside development)
// grants an ADMIN viewer with no userId, preserving the pre-3d behavior where
// DEV_AUTH=1 opened the playground and every learn surface locally.
export const getViewer = cache(async (): Promise<Viewer> => {
  const userId = await getSessionUserId();
  if (userId) return { userId, isAdmin: await isAdmin(userId) };
  return { userId: null, isAdmin: isDevAuthEnabled() };
});

// Playground page guard: admins only; everyone else gets the same non-enumerable
// 404 the admin API routes give (never a login redirect — internal surfaces
// shouldn't advertise their existence).
export async function requireAdminPage(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer.isAdmin) notFound();
}

export const isEnrolledInProgram = cache(
  async (userId: string, programId: string): Promise<boolean> => {
    const count = await prisma.enrolledProgram.count({ where: { userId, programId } });
    return count > 0;
  }
);

// Track access is derived through Programs (Tracks are internal — no standalone
// ownership): the viewer must be enrolled in some Program whose plan contains
// this Track.
export const canViewTrack = cache(async (userId: string, trackId: string): Promise<boolean> => {
  const count = await prisma.enrolledProgram.count({
    where: { userId, program: { programPaths: { some: { trackId } } } },
  });
  return count > 0;
});
