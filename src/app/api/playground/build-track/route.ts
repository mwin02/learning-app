// POST /api/playground/build-track — internal trigger that builds a learner's
// Track from a spine_ready concept map (Phase 2.5e-4), so an operator/agent can
// exercise the Track builder from the inspector instead of a tsx script. Sibling
// to map-edit / decomposition-review: same error envelope, same withAdminAuth gate
// (NEVER withAuth — a signed-in customer must not reach it; both are the DEV_AUTH
// placeholder today, they diverge in Phase 3).
//
// Body: { pathId, priorKnowledge?, goal?, timeframeWeeks?, hoursPerWeek?, targetMastery? }.
// Synchronous: this is the seam that becomes a 202 + job id in Phase 3 (audit 1.2).
// On success returns the built Track's id + status + diagnostics; the caller
// redirects to the read-only Track view.

import { z, ZodError } from 'zod';
import { Difficulty } from '@prisma/client';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { buildTrack, TrackBuildError } from '@/lib/agents/track/build-track';
import { createTraceCollector } from '@/lib/agents/agent-trace';

// buildTrack runs a Pro compose call — needs Node, and headroom over the default.
export const runtime = 'nodejs';
export const maxDuration = 60;

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

const bodySchema = z.object({
  pathId: z.string().min(1),
  priorKnowledge: z.string().max(2000).optional(),
  goal: z.string().max(2000).optional(),
  timeframeWeeks: z.number().int().positive().max(520).optional(),
  hoursPerWeek: z.number().int().positive().max(168).optional(),
  targetMastery: z.nativeEnum(Difficulty).optional(),
});

export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Body must be valid JSON.');
  }

  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Invalid build-track body.', err.issues);
    }
    throw err;
  }

  // Always collect the build trace on this admin-only inspector route — it's the
  // window into the composer agent's tool calls (search_candidates, add_lesson, …) and
  // is cheap/ephemeral. (Unlike generate-path, which gates trace behind TRACE_RESPONSE
  // because it's the customer-facing enqueue path.)
  const { onTrace, events } = createTraceCollector();
  try {
    const result = await buildTrack({ ...input, onTrace });
    return Response.json({ ...result, trace: events });
  } catch (err) {
    if (err instanceof TrackBuildError) {
      // Precondition failures (no Path / not spine_ready) carry no `cause`; a
      // mid-build failure wraps the underlying error as `cause`.
      if (!err.cause) {
        const code: ErrorCode = err.message.includes('No Path') ? 'NOT_FOUND' : 'INVALID_STATE';
        return errorResponse(code === 'NOT_FOUND' ? 404 : 409, code, err.message);
      }
      console.error('[build-track route] build failed', err.cause);
      return errorResponse(500, 'INTERNAL', err.message);
    }
    throw err;
  }
});
