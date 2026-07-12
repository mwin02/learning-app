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

import { Difficulty, BankStaleReason } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { judgeCandidates } from '@/lib/agents/map/candidate-judge';
import { selectAttachable, capCandidates } from '@/lib/agents/map/attach-candidates';
import { MAP_MAX_CANDIDATES_PER_CONCEPT } from '@/lib/config';
import { sourceForConcept } from '@/lib/agents/tools/web-fallback';
import { generateOnRampResource } from '@/lib/agents/map/generate-onramp';
import { markBankStale } from '@/lib/agents/content/mark-bank-stale';
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
  // Lever C: judge sourced rows with the strict on-ramp rubric when this concept
  // is the orientation on-ramp, so re-sourcing it can't re-admit deep-dives.
  isOnRamp?: boolean;
  // Budget-fill Block 2: bias discovery toward substantial (~20–90m) resources —
  // set for budget-thin concepts, where more short clips can't fill the tier.
  preferSubstantial?: boolean;
}): Promise<number> {
  const { pathId, topic, conceptId, slug, title, targetMastery, isOnRamp = false, preferSubstantial = false } = args;

  const sourced = await sourceForConcept({ topic, concept: { slug, title }, conceptId, targetMastery, preferSubstantial });
  let rows = await loadAsSearchResults(sourced.insertedIds);

  // Phase 2g-4: on-ramp backstop. The cold build (ensure-path-map) normally authors the
  // on-ramp's generated primary; this covers the case where that generation failed and
  // left the on-ramp a hole, so remediation reaches it. Idempotent (reuses a row the
  // cold build did manage to write). Prepended, deduped — the generated row is already
  // `active`, so the promote-on-attach updateMany below simply no-ops for it.
  if (isOnRamp) {
    const generated = await generateOnRampResource({ topic, concept: { slug, title } });
    if (generated) rows = [generated, ...rows.filter((r) => r.id !== generated.id)];
  }

  if (rows.length === 0) {
    console.log('[source-concept] sourced nothing', { pathId, concept: slug });
    return 0;
  }

  const judged = await judgeCandidates({ conceptTitle: title, conceptSlug: slug, candidates: rows, isOnRamp });
  // Floor + cap the newly-judged set (Lever A) rather than attaching everything > 0.
  // Phase 2g-1: pass the concept's regime so re-sourced candidates get the same scope-
  // aware duration penalty as the cold-build path (strict for the on-ramp).
  const kept = selectAttachable(judged, { isOnRamp });
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
    // Phase 2.5i: if re-sourcing attached a new `teaches` candidate, the concept's
    // primary material moved — flag a reviewed bank stale (no-op while building, since
    // markBankStale only flags reviewed concepts; this fires when a live Path regressed
    // and re-sources an already-reviewed concept).
    if (kept.some((k) => k.role === 'teaches')) {
      await markBankStale(tx, [conceptId], BankStaleReason.primary_changed);
    }
    // Enforce the per-concept cap on the MERGED set so repeated remediation/thicken
    // passes can't accumulate unboundedly. capCandidates (NOT selectAttachable) so
    // we only count-bound — it drops just the lowest-coverage excess beyond the cap
    // and retains the best qualifying primary, so it can never empty a concept or
    // regress readiness. We must NOT re-apply the coverage floor here: these rows
    // were already admitted (possibly under 2.5f relaxed readiness, possibly under
    // the legacy `> 0` rule), and re-flooring could delete a relaxed concept's only
    // candidates. Deleting a ConceptResource is Path-side only (the reject pipeline
    // already does it); immutable Track snapshots reference LessonResource, never
    // these links.
    const links = await tx.conceptResource.findMany({
      where: { conceptId },
      select: { id: true, role: true, coverageScore: true },
    });
    if (links.length > MAP_MAX_CANDIDATES_PER_CONCEPT) {
      const keepIds = new Set(capCandidates(links).map((l) => l.id));
      const dropped = links.filter((l) => !keepIds.has(l.id));
      if (dropped.length > 0) {
        await tx.conceptResource.deleteMany({ where: { id: { in: dropped.map((l) => l.id) } } });
        // Phase 2.5i: removed candidates may have grounded a question. capCandidates
        // retains the best primary, so drops are normally non-`teaches`; flag primary
        // only if a `teaches` link was actually pruned.
        const reason = dropped.some((l) => l.role === 'teaches')
          ? BankStaleReason.primary_changed
          : BankStaleReason.resource_removed;
        await markBankStale(tx, [conceptId], reason);
      }
    }
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
