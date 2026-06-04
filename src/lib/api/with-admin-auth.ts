// Placeholder admin/operator auth middleware. Sibling to withAuth (which gates
// ordinary *user-authenticated* routes); this one gates internal playground and
// admin routes — curation actions, the human-review queue, agent-operator
// endpoints — that a regular signed-in customer must never reach.
//
// Today both wrappers gate on the same env var (DEV_AUTH=1), because there are
// no real sessions yet. They live in separate files on purpose: in Phase 3 they
// diverge. `withAuth` becomes a real Supabase user-session lookup; `withAdminAuth`
// becomes a *role* check (operator/admin) on top of that session. Routes written
// against this wrapper don't change when that happens — only this file does.
//
// Without DEV_AUTH the route looks like it doesn't exist (404 plain text), same
// as withAuth, so internal endpoints aren't even enumerable in a deployed env.

export type AdminSession = {
  // Null until Phase 3 wires real auth. The operating principal — a human
  // curator or an autonomous review agent — once admin sessions exist.
  adminId: string | null;
};

export type AdminHandler = (req: Request, session: AdminSession) => Promise<Response> | Response;

export function withAdminAuth(handler: AdminHandler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (process.env.DEV_AUTH !== '1') {
      return new Response('Not Found', { status: 404 });
    }
    const session: AdminSession = { adminId: null };
    return handler(req, session);
  };
}
