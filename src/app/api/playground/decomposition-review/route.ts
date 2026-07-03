// POST /api/playground/decomposition-review — internal curation API that applies
// a human's *or an agent's* review decision to a container resource sitting in
// the decomposition queue, so we stop hand-editing the DB. Deferred "curation
// actions" item from Phase 2.5b.
//
// Admin/operator-gated via withAdminAuth (see src/lib/api/with-admin-auth.ts) —
// NOT the user-auth withAuth: this must never be reachable by a signed-in
// customer. Today both are the same DEV_AUTH placeholder; they diverge in Phase 3.
//
// Body: { resourceId, action, force? }. The target must currently be queued for
// review (decompositionStatus ∈ {human_review, pending}); any other state is a
// 409 so we can't clobber an already-decided row. Actions:
//   accept_atomic — keep the container whole, pickable as one atomic unit (embeds it)
//   reject        — keep as an unpickable record; leaves the queue (status unsupported)
//   decompose     — run decompose() → decomposeExisting(); force bypasses the
//                   DECOMPOSITION_MAX_AUTO_CHILDREN oversize gate
//   decompose_manual — explode into an operator/agent-supplied ordered child list
//                   (SPA escape hatch; see manual.ts)
// Returns { resourceId, status, childrenCreated?, reason? }. `reason` explains a
// non-decomposed decompose outcome so a caller (incl. an autonomous reviewer) can
// decide whether to retry with force.

import { ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { decompositionReviewSchema } from '@/lib/api/decomposition-review-schema';
import { decompose } from '@/lib/agents/decomposition/decompose';
import { decomposeManual } from '@/lib/agents/decomposition/manual';
import {
  decomposeExisting,
  markAtomic,
  markUnsupported,
} from '@/lib/agents/decomposition/upsert-resource';

// A force-decompose of a large container runs YouTube paging / doc fetch + chunked
// concept-derivation LLM calls and can exceed Vercel's 60s cap — those are a
// Cloud-Run-era operation (same limit generate-path documents). Fine locally.
export const maxDuration = 60;

// Prisma + the decomposition routers (Vertex SDK, fetch) need Node, not Edge.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// Only rows actually queued for review may be acted on — guards against
// re-deciding (or racing) a row that already left the queue.
const REVIEW_QUEUED = ['human_review', 'pending'] as const;

export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = decompositionReviewSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  const resource = await prisma.resource.findUnique({
    where: { id: input.resourceId },
    select: {
      id: true,
      decompositionStatus: true,
      url: true,
      title: true,
      type: true,
      topic: true,
      difficulty: true,
      summary: true,
      conceptsTaught: true,
      durationMin: true,
    },
  });
  if (!resource) {
    return errorResponse(404, 'NOT_FOUND', `Resource ${input.resourceId} not found.`);
  }
  if (!REVIEW_QUEUED.includes(resource.decompositionStatus as (typeof REVIEW_QUEUED)[number])) {
    return errorResponse(
      409,
      'INVALID_STATE',
      `Resource is '${resource.decompositionStatus}', not queued for review (expected human_review or pending).`,
    );
  }

  // The conditional updates inside markAtomic/markUnsupported re-assert the
  // review-queued guard atomically, so a `applied: false` here is a concurrent
  // decision that won the race — surface it as the same 409.
  const raced = () =>
    errorResponse(409, 'INVALID_STATE', 'Resource was decided concurrently; no change applied.');

  try {
    switch (input.action) {
      case 'accept_atomic': {
        const { applied } = await markAtomic(resource.id);
        if (!applied) return raced();
        return Response.json({ resourceId: resource.id, status: 'atomic' });
      }

      case 'reject': {
        const { applied } = await markUnsupported(resource.id);
        if (!applied) return raced();
        return Response.json({ resourceId: resource.id, status: 'unsupported' });
      }

      case 'decompose': {
        const result = await decompose(
          {
            url: resource.url,
            title: resource.title,
            type: resource.type,
            topic: resource.topic,
            difficulty: resource.difficulty,
            summary: resource.summary,
            conceptsTaught: resource.conceptsTaught,
            durationMin: resource.durationMin,
          },
          { force: input.force },
        );
        const { status, childrenCreated } = await decomposeExisting(resource.id, result);
        return Response.json({
          resourceId: resource.id,
          status,
          childrenCreated,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }

      case 'decompose_manual': {
        // No oversize gate / no classify() — the list is operator/agent-vouched.
        // Build children (concepts derived, defaults applied) and persist through
        // the same decomposeExisting() sink as the scrape-based routers.
        const { children } = await decomposeManual({
          items: input.children,
          topic: resource.topic,
          difficulty: resource.difficulty,
          parentConcepts: resource.conceptsTaught,
        });
        const { status, childrenCreated } = await decomposeExisting(resource.id, {
          status: 'decomposed',
          children,
        });
        return Response.json({ resourceId: resource.id, status, childrenCreated });
      }
    }
  } catch (err) {
    console.error('[decomposition-review] failure', { resourceId: resource.id, action: input.action, err });
    return errorResponse(500, 'INTERNAL', 'Internal error applying review decision.');
  }
});
