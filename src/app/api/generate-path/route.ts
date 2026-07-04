// POST /api/generate-path — HTTP boundary for course requests.
//
// Phase 2.5g-4 cutover: this route is now FIRE-AND-FORGET. It does NOT build a
// path/track inline (that structurally exceeded the Vercel function timeout for
// cold topics and wasted spend on client disconnects). Instead:
//   withAuth → JSON parse → Zod validate → topic-validity gate → enqueue a
//   CourseRequest → 202 Accepted { requestId }.
// The out-of-band worker (scripts/course-worker.ts) drains the queue:
// ensurePathMap → remediate → buildTrack → notify (console for now; email is
// Phase 3). The caller is told the request is queued, not handed a result.
//
// The topic gate stays synchronous on purpose: it rejects unsupported topics with
// an immediate 400 and produces the canonical slug we persist on CourseRequest.topic
// (so the worker's get-or-create keys on a normalized topic). It is the only
// non-trivial work left in the request and is bounded (one classification call).
//
// Phase 3c: DEMOTED to admin-only (withAdminAuth). Programs are the only
// user-facing artifact — public creation goes through /api/generate-program
// (which meters per user and wraps even a single topic in a one-slot Program).
// This route stays as the operator/playground tool for building a standalone
// Track outside any Program; the enqueued CourseRequest carries the admin's
// userId for audit.

import { ZodError } from 'zod';
import { generatePathInputSchema } from '@/lib/api/generate-path-schema';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { enqueueCourseRequest } from '@/lib/services/course-request';
import { validateTopic } from '@/lib/agents/topic-gate';
import { createTraceCollector } from '@/lib/agents/agent-trace';

// Prisma + the Vertex SDK (topic gate) need the Node runtime, not Edge. The heavy
// generation moved to the worker, so the request is just gate + insert; the gate's
// worst case (a novel topic's grounded canonicalization) stays well under this.
export const maxDuration = 60;
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'TOPIC_REJECTED' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// The gate trace exposes registry/library internals. We always collect it (cheap),
// but only return it when TRACE_RESPONSE=1 — the route stays internal-only today
// (DEV_AUTH), but Phase 3 swaps in real auth without touching this handler, so gate
// the *return* here rather than relying on the route staying private.
const traceInResponse = process.env.TRACE_RESPONSE === '1';

export const POST = withAdminAuth(async (req, session) => {
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

  const { onTrace, events } = createTraceCollector();
  onTrace({
    kind: 'info',
    label: 'request received',
    detail: { topic: input.topic, timeframeWeeks: input.timeframeWeeks, hoursPerWeek: input.hoursPerWeek },
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

  // Enqueue against the canonical slug so CourseRequest.topic (and the Path the
  // worker get-or-creates) is normalized (e.g. "Organic Chemistry" → "organic-chemistry").
  try {
    const { id } = await enqueueCourseRequest({
      topic: gate.canonical,
      userId: session.adminId,
      priorKnowledge: input.priorKnowledge,
      goal: input.goal,
      timeframeWeeks: input.timeframeWeeks,
      hoursPerWeek: input.hoursPerWeek,
      targetMastery: input.targetMastery,
    });
    console.log('[generate-path] enqueued', { requestId: id, topic: gate.canonical, userId: session.adminId });
    return Response.json(
      { requestId: id, status: 'queued', topic: gate.canonical, ...(traceInResponse ? { trace: events } : {}) },
      { status: 202 },
    );
  } catch (err) {
    console.error('[generate-path] enqueue failure', err);
    return errorResponse(500, 'INTERNAL', 'Internal error.');
  }
});
