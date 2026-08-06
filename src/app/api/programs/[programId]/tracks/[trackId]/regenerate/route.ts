// Reports R5: POST /api/programs/[programId]/tracks/[trackId]/regenerate — rebuild
// one Track of a Program the caller is enrolled in.
//
// Fire-and-forget like /api/generate-program: the whole synchronous part is the
// precondition checks plus one CourseRequest insert, and the caller gets a request id
// to poll. There is no plan pass to run inline — the topic and its Path already exist.
//
// Each refusal is its own code so R7 can explain it by name (already rebuilding, out
// of rebuilds, nothing has changed yet) instead of showing a generic failure.

import { z, ZodError } from 'zod';
import { Difficulty } from '@prisma/client';
import { withAuth } from '@/lib/api/with-auth';
import { log } from '@/lib/log';
import { regenerateTrack } from '@/lib/services/regenerate-track';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ programId: string; trackId: string }> };

// The learner's edited inputs, all optional — an absent field clones the Track's.
// Bounds mirror the Program creation schema's spirit: a rebuild must not become the
// way to request a 400-week course.
const bodySchema = z
  .object({
    priorKnowledge: z.string().trim().max(2000).nullable(),
    goal: z.string().trim().max(2000).nullable(),
    timeframeWeeks: z.number().int().min(1).max(52),
    hoursPerWeek: z.number().int().min(1).max(40),
    targetMastery: z.enum(Difficulty),
  })
  .partial();

export const POST = withAuth<Ctx>(async (req, session, ctx) => {
  // A rebuild is charged to a user (quota, and R6 carries progress over for exactly
  // one learner), so the dev bypass's null userId gets a clean 401 rather than an
  // unattributable build.
  if (!session.userId) {
    return Response.json(
      { error: 'Rebuilding a course requires a signed-in user.', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }

  // An empty body is the common case (rebuild with the same inputs), so a missing or
  // unparseable body is treated as "no edits" rather than refused.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  let overrides: z.infer<typeof bodySchema>;
  try {
    overrides = bodySchema.parse(raw ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      return Response.json(
        { error: 'Request body failed validation.', code: 'INVALID_INPUT', details: err.flatten() },
        { status: 400 }
      );
    }
    throw err;
  }

  const { programId, trackId } = await ctx.params;
  const result = await regenerateTrack({ userId: session.userId, programId, trackId, overrides });

  if (result.ok) {
    log('regenerate-track.accepted', {
      userId: session.userId,
      programId,
      trackId,
      requestId: result.requestId,
      deduplicated: result.deduplicated,
    });
    return Response.json(
      {
        requestId: result.requestId,
        topic: result.topic,
        status: 'queued',
        deduplicated: result.deduplicated,
      },
      { status: 202 }
    );
  }

  switch (result.refusal) {
    case 'not_found':
      return Response.json(
        { error: 'Course not found in this program.', code: 'NOT_FOUND' },
        { status: 404 }
      );
    case 'not_enrolled':
      return Response.json(
        { error: 'You are not enrolled in this program.', code: 'NOT_ENROLLED' },
        { status: 403 }
      );
    case 'already_rebuilding':
      return Response.json(
        { error: 'This course is already being rebuilt.', code: 'ALREADY_REBUILDING' },
        { status: 409 }
      );
    case 'quota_exceeded':
      return Response.json(
        {
          error: `Free plan allows ${result.quota.limit} course rebuild${result.quota.limit === 1 ? '' : 's'} per month.`,
          code: 'FREE_LIMIT_REACHED',
          details: result.quota,
        },
        { status: 429 }
      );
    case 'not_stale':
      // Not an error the learner caused — the counts ride along so R7 can say what
      // has (not) changed and offer editing the inputs as the way forward.
      return Response.json(
        {
          error: 'Nothing has changed since this course was built.',
          code: 'NOT_STALE',
          details: result.staleness,
        },
        { status: 409 }
      );
  }
});
