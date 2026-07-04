// Phase 3f: DB-backed lesson progress for the course player.
//
//   GET  → { lessonIds }          — the user's completed lessons in this track
//   PUT  { lessonId, complete }   — upsert/delete one Progress row
//   POST { lessonIds }            — bulk-complete (the one-shot localStorage →
//                                   DB migration on first signed-in load)
//
// All three require a REAL session — the dev bypass's null userId gets a clean
// 401, like enroll (Progress rows are per-user; there's no owner to write for).
// Track access mirrors the 3d page gate: admins, or enrollment in a Program
// containing the track (canViewTrack). No-access and nonexistent are the same
// 404 (non-enumerable). Lesson membership in the track is validated per write.

import { z, ZodError } from 'zod';
import { withAuth, type Session } from '@/lib/api/with-auth';
import { isAdmin } from '@/lib/api/with-admin-auth';
import { canViewTrack } from '@/lib/auth/viewer';
import {
  loadCompletedLessonIds,
  setLessonComplete,
  bulkCompleteLessons,
} from '@/lib/progress-db';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ trackId: string }> };

const putSchema = z.object({ lessonId: z.string().min(1), complete: z.boolean() });
// Generous cap: real tracks have tens of lessons; this only bounds abuse.
const postSchema = z.object({ lessonIds: z.array(z.string().min(1)).max(500) });

// Session + track-access gate shared by all three methods. Returns the userId
// when allowed, otherwise the error Response to send. canViewTrack first (the
// common learner case), isAdmin as the fallback — both are single lookups and
// React-cache()d per request.
async function authorize(session: Session, trackId: string): Promise<string | Response> {
  if (!session.userId) {
    return Response.json(
      { error: 'Progress requires a signed-in user.', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }
  if (!(await canViewTrack(session.userId, trackId)) && !(await isAdmin(session.userId))) {
    return Response.json({ error: 'Track not found.', code: 'NOT_FOUND' }, { status: 404 });
  }
  return session.userId;
}

async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: 'Request body is not valid JSON.', code: 'INVALID_INPUT' },
      { status: 400 }
    );
  }
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return Response.json(
        { error: 'Request body failed validation.', code: 'INVALID_INPUT', details: err.flatten() },
        { status: 400 }
      );
    }
    throw err;
  }
}

export const GET = withAuth<Ctx>(async (_req, session, ctx) => {
  const { trackId } = await ctx.params;
  const gate = await authorize(session, trackId);
  if (gate instanceof Response) return gate;
  return Response.json({ lessonIds: await loadCompletedLessonIds(gate, trackId) });
});

export const PUT = withAuth<Ctx>(async (req, session, ctx) => {
  const { trackId } = await ctx.params;
  const gate = await authorize(session, trackId);
  if (gate instanceof Response) return gate;
  const body = await parseBody(req, putSchema);
  if (body instanceof Response) return body;
  const ok = await setLessonComplete(gate, trackId, body.lessonId, body.complete);
  if (!ok) {
    return Response.json({ error: 'Lesson not found.', code: 'NOT_FOUND' }, { status: 404 });
  }
  return Response.json({ ok: true });
});

export const POST = withAuth<Ctx>(async (req, session, ctx) => {
  const { trackId } = await ctx.params;
  const gate = await authorize(session, trackId);
  if (gate instanceof Response) return gate;
  const body = await parseBody(req, postSchema);
  if (body instanceof Response) return body;
  const migrated = await bulkCompleteLessons(gate, trackId, body.lessonIds);
  return Response.json({ migrated });
});
