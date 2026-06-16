// Phase 2.5f-3b/4b: the remediation orchestrator — fills a `building` Path's spine
// holes so it can reach `spine_ready`, tying together everything 2.5f built.
//
//   recomputeReadiness → claim job → BOUNDED LOOP over passes:
//     per current hole: classifyHole
//       gap        → sourceForConcept (web search) → judge the sourced rows →
//                    attach the keepers as ConceptResource links, promoting ONLY
//                    those we attach from pending_review to active → recompute
//       conflation → splitConcept (decompose into finer nodes + re-attach); if the
//                    author DECLINES (the concept is actually atomic), fall back to
//                    sourcing it as a gap in the same pass
//   A split creates finer nodes that become the NEXT pass's holes, so the loop
//   iterates: a finer node is re-classified and resolved (covered / sourced /
//   split again) like any other hole. The loop stops on no-holes, a no-progress
//   pass, or MAX_REMEDIATION_PASSES.
//   Then: relax remaining holes that have any candidate (best-effort primary),
//   escalate the truly uncoverable ones, finish the job.
//
// Single-flight is the RemediationJob row (2.5f-1). Invoked manually this block;
// the request-path enqueue + auto-poller are 2.5g. The in-track thicken seam is
// repointed here in 2.5f-5.
//
// Re-judge loads the sourced rows DIRECTLY by id, not via searchResources: the
// ranked search path filters `embedding IS NOT NULL`, and a just-sourced row's
// embedding is written best-effort post-commit, so it would be invisible to a
// semantic re-search in the same run. The insertedIds ARE the candidate set.

import { ConceptResourceRole, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { MAX_REMEDIATION_PASSES } from '@/lib/config';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { judgeCandidates } from '@/lib/agents/map/candidate-judge';
import type { SearchResult } from '@/lib/agents/tools/search-resources';
import { sourceForConcept } from '@/lib/agents/tools/web-fallback';
import { classifyHole, type HoleCandidate } from '@/lib/agents/track/classify-hole';
import { splitConcept, type SliceEvidence } from '@/lib/agents/track/split-concept';
import { claimRemediationJob, finishJob } from '@/lib/agents/track/remediation-job';

export type RemediateResult = {
  // 'busy' when another job holds this Path; 'ready' when there was nothing to
  // fix; otherwise the terminal job state.
  outcome: 'busy' | 'ready' | 'succeeded' | 'escalated' | 'failed';
  status: PathStatus;
  holes: string[];
  relaxedConceptSlugs: string[];
  escalatedConceptSlugs: string[];
};

// The classifier needs role/coverage/conceptsTaught; the splitter also needs each
// candidate's title for its slice evidence — so we carry title alongside.
type HoleEvidenceCandidate = HoleCandidate & { title: string };

type HoleConcept = {
  conceptId: string;
  slug: string;
  title: string;
  candidates: HoleEvidenceCandidate[];
};

export async function remediatePath(
  pathId: string,
  opts: { force?: boolean } = {},
): Promise<RemediateResult> {
  // Recompute from the rows on disk so we act on the current hole set (and rescue
  // a status that drifted). Nothing to do if the spine is already whole.
  const initial = await recomputeReadiness(pathId);
  if (initial.holes.length === 0) {
    console.log('[remediate] no holes; already ready', { pathId, status: initial.status });
    return { outcome: 'ready', status: initial.status, holes: [], relaxedConceptSlugs: [], escalatedConceptSlugs: [] };
  }

  const claim = await claimRemediationJob(pathId, initial.holes, { force: opts.force });
  if (!claim.claimed) {
    console.log('[remediate] busy; another job holds this Path', { pathId });
    return { outcome: 'busy', status: initial.status, holes: initial.holes, relaxedConceptSlugs: [], escalatedConceptSlugs: [] };
  }

  try {
    // --- bounded loop: each pass fixes the current holes; a split adds finer
    // nodes that become the next pass's holes -------------------------------
    for (let pass = 0; pass < MAX_REMEDIATION_PASSES; pass++) {
      const current = await recomputeReadiness(pathId);
      if (current.holes.length === 0) break;
      const { topic, holes } = await loadHoleEvidence(pathId, current.holes);

      let progress = false;
      for (const hole of holes) {
        const cls = classifyHole(hole.candidates);
        console.log('[remediate] hole', { pathId, pass, concept: hole.slug, kind: cls.kind, reason: cls.reason });

        if (cls.kind === 'conflation') {
          const split = await splitConcept({
            pathId,
            topic,
            concept: { id: hole.conceptId, slug: hole.slug, title: hole.title },
            evidence: sliceEvidence(hole),
          });
          if (split.split) {
            progress = true;
            continue;
          }
          // Author declined (concept is actually atomic) → fall through and treat
          // it as a gap in this same pass.
        }
        if (await sourceAndAttach(pathId, topic, hole)) progress = true;
      }

      if (!progress) {
        console.log('[remediate] no progress this pass; stopping loop', { pathId, pass });
        break;
      }
    }

    // --- relax / escalate whatever holes remain -------------------------------
    const after = await recomputeReadiness(pathId);
    const relaxable: string[] = [];
    const uncoverable: string[] = [];
    for (const slug of after.holes) {
      ((await conceptHasCandidate(pathId, slug)) ? relaxable : uncoverable).push(slug);
    }

    // Relaxing accepts the best sub-floor candidate as a best-effort primary, so
    // recompute once more inside the same tx to land the final status atomically.
    const final = await prisma.$transaction(async (tx) => {
      if (relaxable.length > 0) {
        await tx.concept.updateMany({
          where: { pathId, slug: { in: relaxable } },
          data: { primaryRelaxed: true },
        });
      }
      return recomputeReadiness(pathId, tx);
    });

    const state = final.holes.length === 0 ? 'succeeded' : 'escalated';
    await finishJob(claim.job.id, { state, relaxedConceptSlugs: relaxable, escalatedConceptSlugs: uncoverable });

    if (uncoverable.length > 0) {
      // The "page a developer" signal — a structured, greppable record. Real
      // alerting/email is deferred (Phase 3 for email; paging is infra).
      console.error('[remediate] ESCALATION — concepts left uncoverable', {
        pathId,
        uncoverable,
        status: final.status,
      });
    }
    console.log('[remediate] done', { pathId, status: final.status, state, relaxed: relaxable, escalated: uncoverable });
    return { outcome: state, status: final.status, holes: final.holes, relaxedConceptSlugs: relaxable, escalatedConceptSlugs: uncoverable };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(claim.job.id, { state: 'failed', error: message }).catch(() => {});
    console.error('[remediate] failed', { pathId, error: message });
    return { outcome: 'failed', status: initial.status, holes: initial.holes, relaxedConceptSlugs: [], escalatedConceptSlugs: [] };
  }
}

// Source one gap concept, judge the sourced rows, and attach the keepers —
// promoting ONLY the rows we attach from pending_review to active (the locked
// promote-on-attach policy), then recompute readiness, all in one transaction.
// Returns true when it attached at least one candidate (the loop's progress signal).
async function sourceAndAttach(pathId: string, topic: string, hole: HoleConcept): Promise<boolean> {
  const sourced = await sourceForConcept({ topic, concept: { slug: hole.slug, title: hole.title } });
  if (sourced.insertedIds.length === 0) {
    console.log('[remediate] sourced nothing', { pathId, concept: hole.slug });
    return false;
  }

  const rows = await loadAsSearchResults(sourced.insertedIds);
  if (rows.length === 0) return false;

  const judged = await judgeCandidates({ conceptTitle: hole.title, conceptSlug: hole.slug, candidates: rows });
  const kept = judged.filter((j) => j.coverageScore > 0).sort((a, b) => b.coverageScore - a.coverageScore);
  if (kept.length === 0) {
    console.log('[remediate] sourced rows all judged irrelevant', { pathId, concept: hole.slug, sourced: rows.length });
    return false;
  }

  const keptIds = kept.map((k) => k.resourceId);
  await prisma.$transaction(async (tx) => {
    await tx.resource.updateMany({
      where: { id: { in: keptIds }, status: 'pending_review' },
      data: { status: 'active' },
    });
    await tx.conceptResource.createMany({
      data: kept.map((k) => ({
        conceptId: hole.conceptId,
        resourceId: k.resourceId,
        role: k.role,
        coverageScore: k.coverageScore,
      })),
      skipDuplicates: true,
    });
    await recomputeReadiness(pathId, tx);
  });
  console.log('[remediate] attached', {
    pathId,
    concept: hole.slug,
    attached: kept.length,
    topPrimary: kept[0].role === ConceptResourceRole.teaches ? kept[0].coverageScore : null,
  });
  return true;
}

// Slice evidence for the splitter: the hole's `teaches` candidates (title + what
// each teaches). A conflation hole has ≥2 sub-floor teaches by construction; fall
// back to all candidates if somehow none are tagged teaches.
function sliceEvidence(hole: HoleConcept): SliceEvidence[] {
  const teaches = hole.candidates.filter((c) => c.role === ConceptResourceRole.teaches);
  const src = teaches.length > 0 ? teaches : hole.candidates;
  return src.map((c) => ({ title: c.title, conceptsTaught: c.conceptsTaught }));
}

// Load the Path topic + the hole concepts with their candidate evidence (role,
// coverageScore, and the underlying Resource.conceptsTaught for the classifier's
// distinct-slice test). Restricted to the slugs readiness flagged as holes.
async function loadHoleEvidence(
  pathId: string,
  holeSlugs: string[],
): Promise<{ topic: string; holes: HoleConcept[] }> {
  const path = await prisma.path.findUniqueOrThrow({ where: { id: pathId }, select: { topic: true } });
  const concepts = await prisma.concept.findMany({
    where: { pathId, slug: { in: holeSlugs } },
    select: {
      id: true,
      slug: true,
      title: true,
      resources: {
        select: {
          resourceId: true,
          role: true,
          coverageScore: true,
          resource: { select: { title: true, conceptsTaught: true } },
        },
      },
    },
  });
  const holes: HoleConcept[] = concepts.map((c) => ({
    conceptId: c.id,
    slug: c.slug,
    title: c.title,
    candidates: c.resources.map((r) => ({
      resourceId: r.resourceId,
      role: r.role,
      coverageScore: r.coverageScore,
      conceptsTaught: r.resource.conceptsTaught,
      title: r.resource.title,
    })),
  }));
  return { topic: path.topic, holes };
}

// Hydrate freshly-sourced rows into the SearchResult shape the judge consumes,
// loading them directly by id (see the embedding-race note at the top).
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

async function conceptHasCandidate(pathId: string, slug: string): Promise<boolean> {
  const n = await prisma.conceptResource.count({ where: { concept: { pathId, slug } } });
  return n > 0;
}
