// GET/POST /api/playground/map-review — the operator worklist API for the
// Pre-Freeze Map Review (Block 3). GET lists a Path's open findings; POST applies a
// decision (merge / dismiss / keep). Mirrors decomposition-review/route.ts:
// withAdminAuth-gated (never a signed-in customer), conditional updates that guard
// against re-deciding a resolved row (409), and a discriminated-union body.
//
// merge is the only mutating action: it collapses a `duplication` finding's two
// concepts into one (repoint the loser's edges/resources onto the caller-named
// winner, delete the loser) inside a transaction with the finding resolution, then
// recomputes readiness. A merge that would create a prerequisite cycle is refused
// (422) and nothing is written.

import { ZodError } from 'zod';
import { PathReviewResolution } from '@prisma/client';
import { prisma } from '@/lib/db';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { mapReviewActionSchema } from '@/lib/api/map-review-schema';
import { resolveFinding, applyConceptMerge, listOpenFindings } from '@/lib/agents/map/path-review';
import { MergeCycleError } from '@/lib/agents/map/merge-concept';

// Prisma needs Node, not Edge. Merge is a quick DB transaction (no LLM), so the
// default duration is ample.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'CONFLICT' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// GET ?pathId=… | ?topic=… — the open worklist for one Path (or all open findings
// when neither is given). A topic that has no Path is a 404.
export const GET = withAdminAuth(async (req) => {
  const url = new URL(req.url);
  const pathId = url.searchParams.get('pathId')?.trim();
  const topic = url.searchParams.get('topic')?.trim();

  let scopedPathId = pathId || undefined;
  if (!scopedPathId && topic) {
    const path = await prisma.path.findUnique({ where: { topic }, select: { id: true } });
    if (!path) return errorResponse(404, 'NOT_FOUND', `No Path found for topic '${topic}'.`);
    scopedPathId = path.id;
  }

  const findings = await listOpenFindings(scopedPathId);
  return Response.json({ findings });
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
    input = mapReviewActionSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  const finding = await prisma.pathReview.findUnique({
    where: { id: input.reviewId },
    select: { id: true, pathId: true, kind: true, conceptSlugs: true, resolved: true },
  });
  if (!finding) return errorResponse(404, 'NOT_FOUND', `Finding ${input.reviewId} not found.`);
  if (finding.resolved) {
    return errorResponse(409, 'CONFLICT', 'Finding is already resolved.');
  }

  // A conditional-update matching zero rows means a concurrent decision won the race.
  const raced = () => errorResponse(409, 'CONFLICT', 'Finding was decided concurrently; no change applied.');

  try {
    if (input.action === 'dismiss' || input.action === 'keep') {
      const resolution = input.action === 'dismiss' ? PathReviewResolution.dismissed : PathReviewResolution.kept;
      const won = await resolveFinding(input.reviewId, resolution);
      if (!won) return raced();
      return Response.json({ reviewId: finding.id, action: input.action, resolution });
    }

    // --- merge ---------------------------------------------------------------
    if (finding.kind !== 'duplication' || finding.conceptSlugs.length !== 2) {
      return errorResponse(422, 'INVALID_STATE', 'Only a duplication finding with two concepts can be merged.');
    }
    if (!finding.conceptSlugs.includes(input.winnerSlug)) {
      return errorResponse(422, 'INVALID_STATE', `winnerSlug must be one of the finding's concepts: ${finding.conceptSlugs.join(', ')}.`);
    }
    const loserSlug = finding.conceptSlugs.find((s) => s !== input.winnerSlug)!;

    const concepts = await prisma.concept.findMany({
      where: { pathId: finding.pathId, slug: { in: [input.winnerSlug, loserSlug] } },
      select: { id: true, slug: true },
    });
    const idBySlug = new Map(concepts.map((c) => [c.slug, c.id]));
    const winnerId = idBySlug.get(input.winnerSlug);
    const loserId = idBySlug.get(loserSlug);
    if (!winnerId || !loserId) {
      // A concept named by the finding is gone (already merged in a prior decision).
      return errorResponse(422, 'INVALID_STATE', 'A concept named by this finding no longer exists — it may have already been merged.');
    }

    const raceLost = await prisma.$transaction(async (tx) => {
      const won = await resolveFinding(input.reviewId, PathReviewResolution.merged, tx);
      if (!won) return true; // concurrent decision won; nothing written, tx commits a no-op
      await applyConceptMerge(tx, { pathId: finding.pathId, winnerId, loserId });
      return false;
    });
    if (raceLost) return raced();

    return Response.json({
      reviewId: finding.id,
      action: 'merge',
      resolution: PathReviewResolution.merged,
      winnerSlug: input.winnerSlug,
      loserSlug,
      removedConcept: loserSlug,
    });
  } catch (err) {
    if (err instanceof MergeCycleError) {
      return errorResponse(422, 'INVALID_STATE', 'Merge refused: it would create a prerequisite cycle. Resolve manually.');
    }
    console.error('[map-review] failure', { reviewId: input.reviewId, action: input.action, err });
    return errorResponse(500, 'INTERNAL', 'Internal error applying review decision.');
  }
});
