// Placeholder auth middleware. Wraps an App Router handler so route code is
// written *as if* authenticated sessions already exist — when Phase 3 lands
// Supabase Google OAuth, only this file changes; the routes don't.
//
// Today: gates on a single env var (DEV_AUTH=1). Without it, the route looks
// like it doesn't exist (404 plain text). With it, the handler runs and
// receives a placeholder session whose userId is null.
//
// Phase 3: replace the body of `withAuth` with a real session lookup
// (Supabase auth helper, cookie/JWT validation, etc.) and populate
// session.userId from the authenticated user. session.userId flows onto
// CourseRequest.userId when /api/generate-path enqueues — see course-request.ts.

export type Session = {
  // Null until Phase 3 wires real auth. Routes that persist user-owned data
  // must tolerate null (write CourseRequest.userId = null) until then.
  userId: string | null;
};

export type AuthedHandler = (req: Request, session: Session) => Promise<Response> | Response;

export function withAuth(handler: AuthedHandler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (process.env.DEV_AUTH !== '1') {
      return new Response('Not Found', { status: 404 });
    }
    const session: Session = { userId: null };
    return handler(req, session);
  };
}
