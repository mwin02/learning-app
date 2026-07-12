// Library re-judge Block 3 — the decompose-time hook.
//
// When a review decision lands on a container that was sourced for a concept
// (recorded as ResourceSourcedFor provenance, Block 1), the resulting pickable
// rows — the atomic children of a decomposition, or the row itself on
// accept_atomic — should be offered back to the path(s) whose demand caused the
// sourcing. Provenance is only the TRIGGER: a container's children usually span
// many concepts (a 6-hour course → vectors, dot products, matrices…), so each
// demanding path's FULL concept list is considered, with a routing step so a
// concept only pays a judge call for children that are semantically near it.
// The sourcing concept gets no special treatment — it's just one routed
// concept. Scope stays demand-driven: only paths that demanded the container,
// never the whole library.
//
// Routing is a raw pgvector query, not searchResources: that primitive can't
// restrict to an explicit id set (its includeIds only relaxes the status
// window) and skips distance ranking entirely on sets under
// SEARCH_RANK_THRESHOLD — child sets are always that small. One query-embedding
// call per path concept; children were embedded when they were created
// (decomposeExisting / markAtomic), and a child whose best-effort embed failed
// is simply not routable this pass.
//
// Best-effort by contract: the caller (decomposition-review route) invokes this
// AFTER the decomposition committed — a failure here logs and reports, never
// un-decides the review.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { embedQuery } from '@/lib/ai/embeddings';
import { judgeAndAttachCandidates } from '@/lib/agents/track/source-concept';
import { REJUDGE_ROUTE_MAX_DISTANCE, MAP_MAX_CANDIDATES_PER_CONCEPT } from '@/lib/config';

export type RejudgeAttachment = {
  pathId: string;
  conceptSlug: string;
  // How many candidates routed to this concept (passed the distance floor, post-cap).
  routed: number;
  // How many the judge actually attached.
  attached: number;
};

export type RejudgeResult = {
  // Surviving provenance pairs for the resource (concept deletions cascade, so
  // 0 pairs is the clean no-op case, not an error).
  pairs: number;
  // Pickable candidate rows the review decision produced (0 = nothing to offer:
  // the row parked again, was rejected, or decomposed into containers only —
  // includes the over-ceiling accept_atomic case, which the attach floor drops).
  candidates: number;
  attachments: RejudgeAttachment[];
};

export async function rejudgeForDemandingPaths(resourceId: string): Promise<RejudgeResult> {
  const pairs = await prisma.resourceSourcedFor.findMany({
    where: { resourceId },
    select: { concept: { select: { pathId: true } } },
  });
  if (pairs.length === 0) return { pairs: 0, candidates: 0, attachments: [] };

  // The review decision determines what's now pickable: the row itself after
  // accept_atomic; the atomic children after a decompose. Anything else (parked
  // again, rejected 'unsupported') offers nothing.
  const row = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { decompositionStatus: true },
  });
  let candidateIds: string[] = [];
  if (row?.decompositionStatus === 'atomic') {
    candidateIds = [resourceId];
  } else if (row?.decompositionStatus === 'decomposed') {
    const children = await prisma.resource.findMany({
      where: { parentResourceId: resourceId, decompositionStatus: 'atomic' },
      select: { id: true },
    });
    candidateIds = children.map((c) => c.id);
  }
  if (candidateIds.length === 0) {
    return { pairs: pairs.length, candidates: 0, attachments: [] };
  }

  // Every concept of every demanding path — routing (below) decides which of
  // them actually pay a judge call.
  const pathIds = [...new Set(pairs.map((p) => p.concept.pathId))];
  const concepts = await prisma.concept.findMany({
    where: { pathId: { in: pathIds } },
    select: { id: true, pathId: true, slug: true, title: true, isOnRamp: true },
  });

  const attachments: RejudgeAttachment[] = [];
  for (const concept of concepts) {
    const routed = await routeCandidates(concept.title, candidateIds);
    if (routed.length === 0) continue;
    const attached = await judgeAndAttachCandidates({
      pathId: concept.pathId,
      conceptId: concept.id,
      slug: concept.slug,
      title: concept.title,
      candidateIds: routed,
      // Lever C: the on-ramp keeps its strict orientation-only rubric here too,
      // or a decomposed deep-dive chapter could re-magnetize it.
      isOnRamp: concept.isOnRamp,
      reason: 'decompose-rejudge',
    });
    attachments.push({ pathId: concept.pathId, conceptSlug: concept.slug, routed: routed.length, attached });
  }

  console.log('[rejudge-sourced-for] done', {
    resourceId,
    pairs: pairs.length,
    candidates: candidateIds.length,
    judgedConcepts: attachments.length,
    attached: attachments.reduce((n, a) => n + a.attached, 0),
  });
  return { pairs: pairs.length, candidates: candidateIds.length, attachments };
}

// Rank the candidate set by pgvector distance to the concept title and keep the
// near ones: under the distance ceiling (floor is generous on purpose — the
// judge gates quality; this only prunes obvious non-matches so a 23-chapter
// container doesn't fan 23 candidates into every concept's judge call), capped
// at the per-concept candidate budget.
async function routeCandidates(conceptTitle: string, candidateIds: string[]): Promise<string[]> {
  const vec = `[${(await embedQuery(conceptTitle)).join(',')}]`;
  const ranked = await prisma.$queryRaw<{ id: string; distance: number }[]>`
    SELECT id, (embedding <=> ${vec}::vector)::float8 AS distance
    FROM "Resource"
    WHERE id IN (${Prisma.join(candidateIds)}) AND embedding IS NOT NULL
    ORDER BY distance
  `;
  return ranked
    .filter((r) => r.distance <= REJUDGE_ROUTE_MAX_DISTANCE)
    .slice(0, MAP_MAX_CANDIDATES_PER_CONCEPT)
    .map((r) => r.id);
}
