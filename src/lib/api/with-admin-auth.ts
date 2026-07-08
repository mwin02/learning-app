// Phase 3b: real admin/operator auth — a ROLE check on top of the session, per
// audit 9.1 (previously this and withAuth shared the DEV_AUTH flag, so enabling
// user generation also exposed the curation API). Gates internal playground and
// admin routes: curation actions, the human-review queue, agent-operator
// endpoints — surfaces a regular signed-in customer must never reach.
//
// Order of checks:
//   1. Real session AND User.role === 'admin' (one indexed PK lookup — admin
//      routes are low-traffic, so the per-request DB hit is fine and means a
//      role revocation takes effect immediately, with no stale JWT window).
//   2. Dev bypass: NODE_ENV=development AND DEV_AUTH=1 (adminId null), so the
//      local playground works without OAuth setup. Dead in production builds.
//   3. Otherwise 404 plain text — NOT 401/403: unlike user routes, internal
//      endpoints shouldn't even be enumerable, matching the Phase-2d behavior.
//
// Roles are assigned by hand (SQL/Studio: UPDATE "User" SET role='admin' …);
// there is deliberately no API for it.

import { prisma } from '@/lib/db';
import { devBypass, getSessionUserId } from '@/lib/api/with-auth';
import { requireSameOrigin } from '@/lib/api/origin-check';

export type AdminSession = {
  // The operating principal — a human curator or an autonomous review agent.
  // Null only under the dev bypass.
  adminId: string | null;
};

export type AdminHandler = (req: Request, session: AdminSession) => Promise<Response> | Response;

export async function isAdmin(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role === 'admin';
}

export function withAdminAuth(handler: AdminHandler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const userId = await getSessionUserId();
    const admin = await isAdmin(userId);
    if (!admin && !devBypass()) return new Response('Not Found', { status: 404 });
    // H2 (audit 9.7): origin check AFTER the admin check — an unauthenticated
    // scanner probing with a bad Origin still sees the masking 404, not a
    // route-revealing 403. CSRF protection is unaffected: a forged request
    // riding an admin's cookie passes the role check and is rejected here.
    const originError = requireSameOrigin(req);
    if (originError) return originError;
    return handler(req, { adminId: admin ? userId : null });
  };
}
