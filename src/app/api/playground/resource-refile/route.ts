// /api/playground/resource-refile — the reviewer's filing correction (Q9).
//
// POST { resourceId, topic } → moves the row's PRIMARY topic membership through
// `setPrimaryTopic` (the one write seam allowed to touch `ResourceTopic.isPrimary`
// and the `Resource.topic` mirror together), stamped `origin: 'review'`.
// Deliberately not part of PATCH /api/playground/resources: that endpoint's
// whitelist is metadata, and `topic` is a mirror of a membership row, not a field.
//
// A refusal (unknown slug, unchanged topic, vanished row) is a 409, not a 500 —
// nothing was written and the reviewer can act on the reason as written.
//
// Admin/operator-gated via withAdminAuth, same as its siblings: never reachable by
// a signed-in customer, and one JSON contract for the queue UI and a review agent.

import { ZodError } from 'zod';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { resourceRefileSchema } from '@/lib/api/resource-refile-schema';
import { refileToTopic } from '@/lib/curation/refile-topic';
import { logError } from '@/lib/log';

// Prisma needs the Node runtime (not Edge). A registry read plus one short
// transaction — the default duration is fine.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'INVALID_STATE' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = resourceRefileSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  try {
    const result = await refileToTopic(input.resourceId, input.topic);
    if (result.kind === 'refused') {
      return errorResponse(409, 'INVALID_STATE', result.reason);
    }
    return Response.json({ resourceId: input.resourceId, topic: result.topic, origin: 'review' });
  } catch (err) {
    logError('resource-refile.failed', { resourceId: input.resourceId, err });
    return errorResponse(500, 'INTERNAL', 'Internal error applying refile.');
  }
});
