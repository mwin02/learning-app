// /api/playground/resources — admin metadata correction for any Resource row,
// regardless of status (the review skill fixes pending rows; the cleanup/audit
// block reuses it on active ones).
//
// PATCH — { resourceId, fields: { durationMin?, title?, summary?, difficulty?,
//         requiresPurchase?, type? } }. Whitelist only; see
//         resource-update-schema.ts for what's excluded and why, and for the
//         narrowing on `type` (article | video, atomic rows only — a type edit on
//         a container is refused as INVALID_INPUT with nothing written) and on
//         `durationMin` (null clears it back to an unmeasured state).
//         Responds with the updated row + flags: `embeddingStale` when a
//         title/summary edit made the stored embedding stale (the backfill will
//         re-embed), `warning` when the row now sits over the attach ceiling
//         (surfaced, never auto-parked — lifecycle stays with the review/
//         decompose APIs).
//
// Admin/operator-gated via withAdminAuth, same as pending-resources: never
// reachable by a signed-in customer; drives both the review skill and a future
// curator UI through one JSON contract.

import { ZodError } from 'zod';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { resourceUpdateSchema } from '@/lib/api/resource-update-schema';
import { updateResource } from '@/lib/curation/update-resource';
import { logError } from '@/lib/log';

// Prisma needs the Node runtime (not Edge). A lookup + single-row update — the
// default duration is fine.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

export const PATCH = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = resourceUpdateSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  try {
    const result = await updateResource(input.resourceId, input.fields);
    if (result.kind === 'not_found') {
      return errorResponse(404, 'NOT_FOUND', `Resource ${input.resourceId} not found.`);
    }
    // A refusal is a bad request against THIS row's state (a type edit on a
    // container), not a server fault: nothing was written and the operator has to
    // choose a different tool.
    if (result.kind === 'refused') {
      return errorResponse(400, 'INVALID_INPUT', result.reason);
    }
    return Response.json({
      resource: result.resource,
      changed: result.changed,
      embeddingStale: result.embeddingStale,
      ...(result.warning !== undefined ? { warning: result.warning } : {}),
    });
  } catch (err) {
    logError('resources.update-failed', { resourceId: input.resourceId, err });
    return errorResponse(500, 'INTERNAL', 'Internal error applying resource update.');
  }
});
