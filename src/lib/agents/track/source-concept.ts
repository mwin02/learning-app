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
//
// Library re-judge Block 2: the judge → attach tail is factored out as
// judgeAndAttachCandidates so callers holding EXISTING candidate ids (the
// decompose-time hook, rung-0 library candidates) run the identical pipeline
// without a web-sourcing round. sourceAndAttachConcept = sourceForConcept →
// on-ramp backstop → judgeAndAttachCandidates(insertedIds).

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
  // Audit 2.2: the worker's per-job abort (deadline/shutdown), threaded down into
  // the sourcing ladder's AI/web calls and the judge — remediation's per-hole
  // loop is the single most expensive unthreaded stretch without it.
  abortSignal?: AbortSignal;
}): Promise<number> {
  const { pathId, topic, conceptId, slug, title, targetMastery, isOnRamp = false, preferSubstantial = false, abortSignal } = args;

  const sourced = await sourceForConcept({ topic, concept: { slug, title }, conceptId, targetMastery, preferSubstantial, abortSignal });
  // Rung-0 library hits first (already embedded + semantically ranked), then the
  // fresh web finds. Disjoint by construction: library ids are existing rows,
  // insertedIds are rows this run just created.
  let candidateIds = [...sourced.libraryCandidateIds, ...sourced.insertedIds];

  // Phase 2g-4: on-ramp backstop. The cold build (ensure-path-map) normally authors the
  // on-ramp's generated primary; this covers the case where that generation failed and
  // left the on-ramp a hole, so remediation reaches it. Idempotent (reuses a row the
  // cold build did manage to write). Prepended, deduped — the generated row is already
  // `active`, so the promote-on-attach updateMany in the attach tail no-ops for it.
  if (isOnRamp) {
    const generated = await generateOnRampResource({ topic, concept: { slug, title }, abortSignal });
    if (generated) candidateIds = [generated.id, ...candidateIds.filter((id) => id !== generated.id)];
  }

  return judgeAndAttachCandidates({
    pathId,
    conceptId,
    slug,
    title,
    candidateIds,
    targetMastery,
    isOnRamp,
    reason: 'source-concept',
    abortSignal,
  });
}

// Library re-judge Block 2: the judge → attach tail as a standalone primitive, so
// callers that already HAVE candidate ids (the decompose-time hook re-judging a
// container's children, rung-0 library candidates) reuse the exact
// judge/floor/cap/promote/readiness pipeline that remediation uses.
//
// Loads candidates DIRECTLY by id (see the embedding-race note above), drops any
// already attached to this concept (re-judging an attached row would just churn
// the judge), judges with the concept's regime, and attaches the keepers in one
// transaction. Returns how many candidates it attached (0 = nothing new).
export async function judgeAndAttachCandidates(args: {
  pathId: string;
  conceptId: string;
  slug: string;
  title: string;
  candidateIds: string[];
  // Logged only — the attach tail is mastery-agnostic (discovery already biased);
  // kept in the signature so call sites read like their sourcing context.
  targetMastery?: Difficulty;
  // Lever C: strict orientation-only judge rubric for the on-ramp concept.
  isOnRamp?: boolean;
  // For logs: which flow demanded this judge pass (remediation, decompose hook…).
  reason?: string;
  // Audit 2.2: forwarded into the judge call; checked before the attach tx so an
  // aborted job stops WRITING (ConceptResource attaches racing a successor build).
  abortSignal?: AbortSignal;
}): Promise<number> {
  const { pathId, conceptId, slug, title, candidateIds, targetMastery, isOnRamp = false, reason = 'judge-attach', abortSignal } = args;

  // Exclude rows already attached to this concept: they were judged when they
  // attached, and re-attaching is a createMany no-op anyway — spending judge
  // tokens on them is pure waste. (Today's sourcing callers can't hit this —
  // insertedIds are new rows — but the hook and rung 0 re-judge library rows.)
  let ids = candidateIds;
  if (ids.length > 0) {
    const attached = await prisma.conceptResource.findMany({
      where: { conceptId, resourceId: { in: ids } },
      select: { resourceId: true },
    });
    const attachedIds = new Set(attached.map((a) => a.resourceId));
    ids = ids.filter((id) => !attachedIds.has(id));
  }

  const rows = await loadAsSearchResults(ids);

  if (rows.length === 0) {
    console.log('[source-concept] no candidates to judge', { pathId, concept: slug, reason });
    return 0;
  }

  const judged = await judgeCandidates({ conceptTitle: title, conceptSlug: slug, candidates: rows, isOnRamp, abortSignal });
  // Floor + cap the newly-judged set (Lever A) rather than attaching everything > 0.
  // Phase 2g-1: pass the concept's regime so re-sourced candidates get the same scope-
  // aware duration penalty as the cold-build path (strict for the on-ramp).
  const kept = selectAttachable(judged, { isOnRamp });
  if (kept.length === 0) {
    console.log('[source-concept] candidates all judged irrelevant', { pathId, concept: slug, reason, candidates: rows.length });
    return 0;
  }

  const keptIds = kept.map((k) => k.resourceId);
  abortSignal?.throwIfAborted();
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
    // A3: join the resource's live trustScore + durationMin so the cap ranks by
    // the full selection blend — a vote-damaged resource loses the cap fight it
    // would lose at fresh attach. (Before A3 this select was coverage-only and
    // capCandidates fell back to pure coverage here.) Still ordering-only: the
    // cap's primary retention stays a coverage gate.
    const links = (
      await tx.conceptResource.findMany({
        where: { conceptId },
        select: {
          id: true,
          role: true,
          coverageScore: true,
          resource: { select: { trustScore: true, durationMin: true } },
        },
      })
    ).map((l) => ({
      id: l.id,
      role: l.role,
      coverageScore: l.coverageScore,
      trustScore: l.resource.trustScore,
      durationMin: l.resource.durationMin,
    }));
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
  console.log('[source-concept] attached', { pathId, concept: slug, attached: kept.length, reason, targetMastery: targetMastery ?? null });
  return kept.length;
}

// Hydrate candidate rows into the SearchResult shape the judge consumes, loading
// them directly by id (see the embedding-race note above). Preserves the caller's
// id order (findMany returns DB order) — the on-ramp backstop relies on its
// generated row coming first.
async function loadAsSearchResults(ids: string[]): Promise<SearchResult[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.resource.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, slug: true, topic: true, title: true, url: true, type: true, tier: true,
      difficulty: true, durationMin: true, summary: true, prerequisiteConcepts: true,
      conceptsTaught: true, requiresPurchase: true, trustScore: true, decompositionStatus: true,
    },
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .map((r) => ({ ...r, distance: null }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
