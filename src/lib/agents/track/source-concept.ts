// Phase 2.5f-5: the per-concept "source more candidates" primitive, shared by the
// two callers that grow a concept's resource set:
//   - spine-hole remediation (remediate-path.ts) — a concept with no qualifying
//     teaches; source mastery-agnostically to reach the readiness floor.
//   - the in-track thickener (thicken-seam.ts) — a concept that HAS a primary but
//     whose resources are too shallow for the learner's target mastery; source
//     biased toward that level.
//
// Both do the same thing: sourceForConcept (web search) → judge the sourced rows →
// attach the keepers as ConceptResource links, promoting ONLY those we attach from
// pending_review to active (the locked promote-on-attach policy) → recompute, all
// in one transaction. Returns how many candidates it attached (0 = nothing new).
//
// Re-judge loads the sourced rows DIRECTLY by id, not via searchResources: the
// ranked search path filters `embedding IS NOT NULL`, and a just-sourced row's
// embedding is written best-effort post-commit, so it would be invisible to a
// semantic re-search in the same run. The insertedIds ARE the candidate set.

import { Difficulty } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { judgeCandidates } from '@/lib/agents/map/candidate-judge';
import { sourceForConcept } from '@/lib/agents/tools/web-fallback';
import type { SearchResult } from '@/lib/agents/tools/search-resources';

export async function sourceAndAttachConcept(args: {
  pathId: string;
  topic: string;
  conceptId: string;
  slug: string;
  title: string;
  // Biases discovery toward a learner level (the in-track thickener). Omitted by
  // mastery-agnostic spine-hole remediation.
  targetMastery?: Difficulty;
}): Promise<number> {
  const { pathId, topic, conceptId, slug, title, targetMastery } = args;

  const sourced = await sourceForConcept({ topic, concept: { slug, title }, targetMastery });
  if (sourced.insertedIds.length === 0) {
    console.log('[source-concept] sourced nothing', { pathId, concept: slug });
    return 0;
  }

  const rows = await loadAsSearchResults(sourced.insertedIds);
  if (rows.length === 0) return 0;

  const judged = await judgeCandidates({ conceptTitle: title, conceptSlug: slug, candidates: rows });
  const kept = judged.filter((j) => j.coverageScore > 0).sort((a, b) => b.coverageScore - a.coverageScore);
  if (kept.length === 0) {
    console.log('[source-concept] sourced rows all judged irrelevant', { pathId, concept: slug, sourced: rows.length });
    return 0;
  }

  const keptIds = kept.map((k) => k.resourceId);
  await prisma.$transaction(async (tx) => {
    await tx.resource.updateMany({
      where: { id: { in: keptIds }, status: 'pending_review' },
      data: { status: 'active' },
    });
    await tx.conceptResource.createMany({
      data: kept.map((k) => ({ conceptId, resourceId: k.resourceId, role: k.role, coverageScore: k.coverageScore })),
      skipDuplicates: true,
    });
    await recomputeReadiness(pathId, tx);
  });
  console.log('[source-concept] attached', { pathId, concept: slug, attached: kept.length, targetMastery: targetMastery ?? null });
  return kept.length;
}

// Hydrate freshly-sourced rows into the SearchResult shape the judge consumes,
// loading them directly by id (see the embedding-race note above).
async function loadAsSearchResults(ids: string[]): Promise<SearchResult[]> {
  const rows = await prisma.resource.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, slug: true, topic: true, title: true, url: true, type: true, tier: true,
      difficulty: true, durationMin: true, summary: true, prerequisiteConcepts: true,
      conceptsTaught: true, requiresPurchase: true, trustScore: true, decompositionStatus: true,
    },
  });
  return rows.map((r) => ({ ...r, distance: null }));
}
