// POST /api/generate-path — HTTP boundary for the curriculum agent.
//
// Pipeline: withAuth → JSON parse → Zod validate → topic-validity gate →
// PathService.createPath (generateCurriculum + Path/PathItem persistence).
//
// Access control is delegated to withAuth (see src/lib/api/with-auth.ts).
// Today that's a placeholder env check (DEV_AUTH=1); Phase 3 swaps the
// internals to a real Supabase session lookup without touching this file.

import { ZodError } from 'zod';
import { generatePathInputSchema } from '@/lib/api/generate-path-schema';
import { withAuth } from '@/lib/api/with-auth';
import { CurriculumAgentError } from '@/lib/curriculum-agent';
import { createPath } from '@/lib/services/path-service';
import { validateTopic } from '@/lib/topic-gate';
import { createTraceCollector } from '@/lib/agent-trace';

// Vercel Hobby allows up to 60s per function. Cold-topic runs (web fallback
// + Pro discovery + validation) can exceed this; those will fail until we
// move to Cloud Run. Documented in docs/ROADMAP.md.
export const maxDuration = 60;

// Prisma + the Vertex SDK need the Node runtime, not Edge.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'TOPIC_REJECTED' | 'GENERATION_FAILED' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// The agent trace exposes internal pipeline structure (stage/tool names, token
// counts, registry/library internals, critic feedback). We always collect it
// (it's cheap and side-effect-free), but only return it to the caller when
// TRACE_RESPONSE=1. Today the route is internal-only (DEV_AUTH), but Phase 3
// swaps in real auth without touching this handler — so gate the *return* here
// rather than relying on the route staying private, or every customer would
// receive the trace in their response. Don't reuse DEV_AUTH: it's removed in
// Phase 3.
const traceInResponse = process.env.TRACE_RESPONSE === '1';

export const POST = withAuth(async (req, session) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = generatePathInputSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  // Collect a structured agent trace spanning the full pipeline (gate →
  // registry → retrieval → fallback → select → critique → revise). Collection
  // is always on (cheap, no side effects); whether it's returned to the caller
  // is gated by TRACE_RESPONSE (see `traceInResponse`). Ephemeral — not stored.
  const { onTrace, events } = createTraceCollector();
  onTrace({
    kind: 'info',
    label: 'request received',
    detail: {
      topic: input.topic,
      difficulty: input.difficulty,
      timeframeWeeks: input.timeframeWeeks,
      hoursPerWeek: input.hoursPerWeek,
    },
  });

  let gate;
  try {
    gate = await validateTopic(input.topic, { onTrace });
  } catch (err) {
    console.error('[generate-path] topic-gate failure', err);
    return errorResponse(500, 'INTERNAL', 'Internal error.');
  }

  if (!gate.valid) {
    return errorResponse(400, 'TOPIC_REJECTED', 'Topic is not within the supported domains.', {
      reason: gate.reason,
      ...(traceInResponse ? { trace: events } : {}),
    });
  }

  // Use the canonical slug from the gate so the persisted Path.topic is
  // normalized (e.g. "Organic Chemistry" → "organic-chemistry").
  const normalized = { ...input, topic: gate.canonical };

  try {
    const { pathId } = await createPath(normalized, session, { onTrace });
    return Response.json(
      { pathId, status: 'created', ...(traceInResponse ? { trace: events } : {}) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof CurriculumAgentError) {
      // Semantic failure: agent returned junk or no usable resources even
      // after web fallback. Distinct from infra failures (DB down, Vertex
      // auth) which become 500.
      console.error('[generate-path] agent failure', err);
      return errorResponse(422, 'GENERATION_FAILED', err.message);
    }
    console.error('[generate-path] internal failure', err);
    return errorResponse(500, 'INTERNAL', 'Internal error.');
  }
});
