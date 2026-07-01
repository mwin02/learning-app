// POST /api/generate-program — HTTP boundary for Programs (Phase 2.75d).
//
// Mirrors /api/generate-path's shape, one level up. The SYNCHRONOUS part here is the
// plan pass (decompose → gate → deterministic budget), the analog of generate-path's
// synchronous topic gate: it's bounded (one Gemini decomposition + ≤N topic-gate
// calls, most cached) and produces the plan we persist. Only the per-topic BUILDS are
// async — enqueueProgram fans them onto the existing CourseRequest queue and the
// worker drains them, exactly as a standalone request. The caller gets a programId to
// poll, not a finished program.
//
// Access control is delegated to withAuth (today the DEV_AUTH placeholder; Phase 3
// swaps in a real Supabase session and populates session.userId → Program.userId
// without touching this file).

import { ZodError } from 'zod';
import { generateProgramInputSchema } from '@/lib/api/generate-program-schema';
import { withAuth } from '@/lib/api/with-auth';
import { enqueueProgram } from '@/lib/services/program';

// Prisma + the Vertex SDK (plan pass) need the Node runtime, not Edge. The plan
// pass's worst case (one Pro-tier-free Flash decomposition + a handful of topic-gate
// classifications) stays well under this; the heavy building is on the worker.
export const maxDuration = 60;
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'PLAN_EMPTY' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

export const POST = withAuth(async (req, session) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = generateProgramInputSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  // enqueueProgram never throws — a plan/fan-out failure is recorded on the Program
  // as `failed` and returned here, so a failed plan still yields a pollable programId.
  let result;
  try {
    result = await enqueueProgram({ ...input, userId: session.userId });
  } catch (err) {
    console.error('[generate-program] unexpected enqueue failure', err);
    return errorResponse(500, 'INTERNAL', 'Internal error.');
  }

  if (result.status === 'failed') {
    // The plan produced no buildable topics (all out-of-domain / cut). 422: the
    // request was well-formed but couldn't be turned into a program. The programId is
    // returned so the failure is inspectable.
    return errorResponse(422, 'PLAN_EMPTY', result.error ?? 'Could not build a program from this goal.', {
      programId: result.programId,
    });
  }

  console.log('[generate-program] enqueued', {
    programId: result.programId,
    topicCount: result.topicCount,
    userId: session.userId,
  });
  return Response.json(
    { programId: result.programId, status: result.status, topicCount: result.topicCount },
    { status: 202 },
  );
});
