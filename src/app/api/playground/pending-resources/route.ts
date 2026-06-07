// /api/playground/pending-resources — the status-approval API for the
// pending_review → active | deprecated lifecycle. The web fallback inserts
// discovered resources as pending_review (usable in the discovering run, hidden
// from future runs by the gate); this endpoint promotes the good ones and
// deprecates the rest.
//
// GET  — list the queue (top-level pending_review resources + their direct
//        children). Shared, machine-readable view for a curator UI or an
//        autonomous reviewer.
// POST — apply one decision: { resourceId, action, cascade? }. See
//        pending-review-schema.ts for the contract.
//
// Admin/operator-gated via withAdminAuth (NOT the user-auth withAuth): never
// reachable by a signed-in customer. Designed for both humans and agents — the
// same JSON contract drives the playground buttons and a future review agent.

import { ZodError } from 'zod';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { pendingReviewSchema } from '@/lib/api/pending-review-schema';
import { listPendingReview, applyPendingReview } from '@/lib/curation/pending-review';

// Prisma needs the Node runtime (not Edge). The recursive-CTE subtree walk and
// the conditional updates are quick, so the default duration is fine.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// ?limit=N caps the queue to the N oldest roots (FIFO) so an agent can pull a
// bounded batch, process it, then ask for the next. Invalid/absent → no cap.
export const GET = withAdminAuth(async (req) => {
  const raw = new URL(req.url).searchParams.get('limit');
  let limit: number | undefined;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return errorResponse(400, 'INVALID_INPUT', '`limit` must be a positive integer.');
    }
    limit = n;
  }
  const queue = await listPendingReview(limit);
  return Response.json({ resources: queue, count: queue.length });
});

export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = pendingReviewSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  try {
    const result = await applyPendingReview(input);
    switch (result.kind) {
      case 'not_found':
        return errorResponse(404, 'NOT_FOUND', `Resource ${input.resourceId} not found.`);
      case 'blocked':
        return errorResponse(
          409,
          'INVALID_STATE',
          `Resource decomposition is '${result.decompositionStatus}', not resolved. Resolve it in Human review before approving.`,
        );
      case 'raced':
        return errorResponse(
          409,
          'INVALID_STATE',
          'Resource was decided concurrently (no longer pending); no change applied.',
        );
      case 'approved':
        return Response.json({ resourceId: result.resourceId, action: 'approve', approved: result.approved });
      case 'rejected':
        return Response.json({
          resourceId: result.resourceId,
          action: 'reject',
          deprecated: result.deprecated,
          pathItemsRemoved: result.pathItemsRemoved,
        });
    }
  } catch (err) {
    console.error('[pending-resources] failure', { resourceId: input.resourceId, action: input.action, err });
    return errorResponse(500, 'INTERNAL', 'Internal error applying review decision.');
  }
});
