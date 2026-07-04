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
import { getSessionUserId } from '@/lib/api/with-auth';

export type AdminSession = {
  // The operating principal — a human curator or an autonomous review agent.
  // Null only under the dev bypass.
  adminId: string | null;
};

export type AdminHandler = (req: Request, session: AdminSession) => Promise<Response> | Response;

function devBypass(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.DEV_AUTH === '1';
}

export async function isAdmin(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role === 'admin';
}

export function withAdminAuth(handler: AdminHandler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const userId = await getSessionUserId();
    if (await isAdmin(userId)) return handler(req, { adminId: userId });
    if (devBypass()) return handler(req, { adminId: null });
    return new Response('Not Found', { status: 404 });
  };
}
