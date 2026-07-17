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

import { ConceptResourceRole, PathStatus, RemediationState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { MAX_REMEDIATION_PASSES } from '@/lib/config';
import { shouldFastFailEscalated } from '@/lib/agents/track/escalation-cooldown';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { classifyHole, type HoleCandidate } from '@/lib/agents/track/classify-hole';
import { splitConcept, type SliceEvidence } from '@/lib/agents/track/split-concept';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';
import { claimRemediationJob, finishJob } from '@/lib/agents/track/remediation-job';
import { reviewAndPersistMap } from '@/lib/agents/map/run-map-review';

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
  isOnRamp: boolean;
  candidates: HoleEvidenceCandidate[];
};

// Public entry: run remediation, then — if THIS call took the Path across the
// `building → spine_ready` freeze boundary — run the pre-freeze map review once
// over the settled map (Pre-Freeze Map Review). The review is best-effort and
// fail-open: it never changes the remediation outcome and a thrown review never
// fails the freeze (the Path is already teachable). It is gated on the transition
// (before ≠ spine_ready, after = spine_ready) so a no-op re-run on an
// already-frozen Path — or an escalated/failed/busy run — does not re-review.
// H4 + audit 2.2: `abortSignal` is the worker's per-job deadline/shutdown
// signal, checked per PASS and per HOLE (each hole can cost minutes of grounded
// discovery + judge calls — the long tail), and forwarded into splitConcept /
// sourceAndAttachConcept down to their AI/web calls. An abort throw lands in
// runRemediation's catch, which fails the RemediationJob and frees the
// active-per-path index. The worker's deadline race is the backstop.
export async function remediatePath(
  pathId: string,
  opts: { force?: boolean; abortSignal?: AbortSignal } = {},
): Promise<RemediateResult> {
  const before = await prisma.path.findUnique({ where: { id: pathId }, select: { status: true } });
  const result = await runRemediation(pathId, opts);

  if (result.status === PathStatus.spine_ready && before?.status !== PathStatus.spine_ready) {
    try {
      const { findings, written } = await reviewAndPersistMap(pathId, { abortSignal: opts.abortSignal });
      console.log('[remediate] freeze review', { pathId, findings: findings.map((f) => f.kind), written });
    } catch (err) {
      console.error('[remediate] freeze review failed (non-fatal)', {
        pathId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

async function runRemediation(
  pathId: string,
  opts: { force?: boolean; abortSignal?: AbortSignal } = {},
): Promise<RemediateResult> {
  // Recompute from the rows on disk so we act on the current hole set (and rescue
  // a status that drifted). Nothing to do if the spine is already whole.
  const initial = await recomputeReadiness(pathId);
  if (initial.holes.length === 0) {
    console.log('[remediate] no holes; already ready', { pathId, status: initial.status });
    return { outcome: 'ready', status: initial.status, holes: [], relaxedConceptSlugs: [], escalatedConceptSlugs: [] };
  }

  // Audit 3.1: a recent run already escalated these exact holes — nothing in the
  // library changed underneath a cool-down, so re-running would re-pay the full
  // per-hole sourcing ladder just to escalate identically. Fail fast WITHOUT
  // claiming a job (no new terminal row per attempt either). --force bypasses.
  if (!opts.force) {
    const lastTerminal = await prisma.remediationJob.findFirst({
      where: {
        pathId,
        state: { in: [RemediationState.succeeded, RemediationState.failed, RemediationState.escalated] },
      },
      orderBy: { updatedAt: 'desc' },
      select: { state: true, updatedAt: true, escalatedConceptSlugs: true },
    });
    if (shouldFastFailEscalated(initial.holes, lastTerminal)) {
      console.log('[remediate] recently escalated; fast-fail without sourcing (cool-down)', {
        pathId,
        holes: initial.holes,
        escalatedAt: lastTerminal!.updatedAt,
      });
      return {
        outcome: 'escalated',
        status: initial.status,
        holes: initial.holes,
        relaxedConceptSlugs: [],
        escalatedConceptSlugs: initial.holes,
      };
    }
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
      opts.abortSignal?.throwIfAborted();
      const current = await recomputeReadiness(pathId);
      if (current.holes.length === 0) break;
      const { topic, holes } = await loadHoleEvidence(pathId, current.holes);

      let progress = false;
      for (const hole of holes) {
        // Audit 2.2: per-HOLE checkpoint — one pass over many holes previously ran
        // minutes of sourcing/judge work after an abort before the per-pass check.
        opts.abortSignal?.throwIfAborted();
        const cls = classifyHole(hole.candidates);
        console.log('[remediate] hole', { pathId, pass, concept: hole.slug, kind: cls.kind, reason: cls.reason });

        if (cls.kind === 'conflation') {
          const split = await splitConcept({
            pathId,
            topic,
            concept: { id: hole.conceptId, slug: hole.slug, title: hole.title },
            evidence: sliceEvidence(hole),
            abortSignal: opts.abortSignal,
          });
          if (split.split) {
            progress = true;
            continue;
          }
          // Author declined (concept is actually atomic) → fall through and treat
          // it as a gap in this same pass.
        }
        // Gap (or declined conflation): source mastery-agnostically (remediation
        // is pre-Track). attached > 0 is the loop's progress signal.
        const attached = await sourceAndAttachConcept({
          pathId,
          topic,
          conceptId: hole.conceptId,
          slug: hole.slug,
          title: hole.title,
          isOnRamp: hole.isOnRamp,
          abortSignal: opts.abortSignal,
        });
        if (attached > 0) progress = true;
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
      isOnRamp: true,
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
    isOnRamp: c.isOnRamp,
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

async function conceptHasCandidate(pathId: string, slug: string): Promise<boolean> {
  const n = await prisma.conceptResource.count({ where: { concept: { pathId, slug } } });
  return n > 0;
}
