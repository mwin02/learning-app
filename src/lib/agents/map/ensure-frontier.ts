// Frontier enrichment pass — persist + resource a map's authored frontier.
//
// Runs after a map's spine is persisted (tail of ensurePathMap, or the backfill
// script over existing maps). Plans via buildFrontier (B1, never throws), then:
//   tx: create the frontier Concepts + their prerequisite edges (edges point
//       only INTO new nodes — the plan's downward-closed invariant — so the
//       spine DAG cannot be corrupted by construction);
//   resource: library-first attachCandidates for the new concepts, then the
//       web-sourcing ladder for at most FRONTIER_MAX_WEB_SOURCED concepts still
//       lacking a qualifying `teaches` primary, in author-priority order. The
//       rest stay unresourced — the composer can't include them, and later
//       enrichment can fill them. Frontier NEVER gates spine_ready:
//       computeReadiness / recomputeReadiness are spine-only by construction.
//
// Idempotence: a map that already has ANY frontier concept is skipped — the
// proxy for "the pass (or a learner request) already ran". A topic whose author
// legitimately proposes zero frontier would re-run on the next call; acceptable.
//
// This CAN throw (DB/sourcing errors): ensurePathMap wraps it best-effort so a
// frontier failure never fails a build, while the backfill script surfaces it.

import { ConceptMembership } from '@prisma/client';
import { prisma } from '@/lib/db';
import { FRONTIER_MAX_WEB_SOURCED } from '@/lib/config';
import { buildFrontier } from '@/lib/agents/map/build-frontier';
import { attachCandidates } from '@/lib/agents/map/attach-candidates';
import { hasQualifyingPrimary } from '@/lib/agents/map/readiness';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type EnsureFrontierResult = {
  // skipped: map already has frontier. empty: the author proposed nothing
  // usable. added: this call created frontier concepts.
  outcome: 'skipped' | 'empty' | 'added';
  added: number;
  // How many of the added concepts ended with a qualifying `teaches` primary.
  resourced: number;
  // How many went through the web-sourcing ladder (≤ FRONTIER_MAX_WEB_SOURCED).
  webSourced: number;
};

export async function ensureFrontier(args: {
  pathId: string;
  subject?: string;
  onTrace?: OnTrace;
  // Audit 2.2: the worker's per-job abort — checked up front and per sourced
  // concept, forwarded into attach/sourcing. An abort throw lands in
  // ensurePathMap's best-effort wrapper, which ships the spine-only map.
  abortSignal?: AbortSignal;
}): Promise<EnsureFrontierResult> {
  const { pathId, subject, onTrace = () => {}, abortSignal } = args;
  abortSignal?.throwIfAborted();

  const path = await prisma.path.findUnique({ where: { id: pathId }, select: { topic: true } });
  if (!path) throw new Error(`No Path '${pathId}'.`);
  const { topic } = path;

  const existing = await prisma.concept.findMany({
    where: { pathId },
    select: { slug: true, title: true, membership: true },
  });
  if (existing.some((c) => c.membership === ConceptMembership.frontier)) {
    onTrace({ kind: 'info', label: 'frontier exists; skipping', detail: { pathId } });
    return { outcome: 'skipped', added: 0, resourced: 0, webSourced: 0 };
  }

  const plan = await buildFrontier({ topic, subject, existing, onTrace });
  if (plan.concepts.length === 0) {
    console.log('[map-ensure-frontier] empty plan', { pathId, topic });
    return { outcome: 'empty', added: 0, resourced: 0, webSourced: 0 };
  }

  // --- persist nodes + edges -------------------------------------------------
  // skipDuplicates on both writes: the advisory-locked build path never races
  // itself, but the backfill script + a concurrent learner request (add-frontier)
  // could collide on a slug; losing that race must not fail the whole pass.
  const idBySlug = await prisma.$transaction(async (tx) => {
    await tx.concept.createMany({
      data: plan.concepts.map((c) => ({
        pathId,
        slug: c.slug,
        title: c.title,
        membership: ConceptMembership.frontier,
      })),
      skipDuplicates: true,
    });
    const rows = await tx.concept.findMany({
      where: { pathId },
      select: { id: true, slug: true },
    });
    const ids = new Map(rows.map((r) => [r.slug, r.id]));
    await tx.conceptPrereq.createMany({
      data: plan.edges.map((e) => ({
        pathId,
        fromConceptId: ids.get(e.fromSlug)!,
        toConceptId: ids.get(e.toSlug)!,
      })),
      skipDuplicates: true,
    });
    return ids;
  });
  onTrace({
    kind: 'stage',
    label: 'frontier persisted',
    detail: { pathId, concepts: plan.concepts.length, edges: plan.edges.length },
  });

  // --- resource: library first ------------------------------------------------
  const attachments = await attachCandidates({ topic, concepts: plan.concepts, onTrace, abortSignal });
  const links = attachments.flatMap((a) =>
    a.candidates.map((c) => ({
      conceptId: idBySlug.get(a.conceptSlug)!,
      resourceId: c.resourceId,
      role: c.role,
      coverageScore: c.coverageScore,
    })),
  );
  if (links.length > 0) await prisma.conceptResource.createMany({ data: links, skipDuplicates: true });

  // --- web-source the top unresourced few, in author-priority order -----------
  const bySlug = new Map(attachments.map((a) => [a.conceptSlug, a]));
  const unresourced = plan.concepts.filter((c) => {
    const a = bySlug.get(c.slug);
    return !a || !hasQualifyingPrimary(a);
  });
  const toSource = unresourced.slice(0, FRONTIER_MAX_WEB_SOURCED);
  for (const c of toSource) {
    abortSignal?.throwIfAborted();
    try {
      await sourceAndAttachConcept({
        pathId,
        topic,
        conceptId: idBySlug.get(c.slug)!,
        slug: c.slug,
        title: c.title,
        abortSignal,
      });
    } catch (err) {
      // A job abort is NOT a per-concept sourcing fault — rethrow instead of
      // continuing the loop over concepts the job no longer owns.
      if (abortSignal?.aborted) throw err;
      // One concept's sourcing failure shouldn't starve the rest of the cap.
      console.warn('[map-ensure-frontier] web sourcing failed', {
        pathId,
        concept: c.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Report the true end state from the rows on disk (sourceAndAttachConcept may
  // attach `uses`/sub-floor rows that don't make a concept teachable).
  const finalLinks = await prisma.conceptResource.findMany({
    where: { conceptId: { in: plan.concepts.map((c) => idBySlug.get(c.slug)!) } },
    select: { conceptId: true, resourceId: true, role: true, coverageScore: true },
  });
  const linksByConcept = new Map<string, typeof finalLinks>();
  for (const l of finalLinks) {
    const list = linksByConcept.get(l.conceptId) ?? [];
    list.push(l);
    linksByConcept.set(l.conceptId, list);
  }
  const resourced = plan.concepts.filter((c) =>
    hasQualifyingPrimary({
      conceptSlug: c.slug,
      candidates: linksByConcept.get(idBySlug.get(c.slug)!) ?? [],
    }),
  ).length;

  const result: EnsureFrontierResult = {
    outcome: 'added',
    added: plan.concepts.length,
    resourced,
    webSourced: toSource.length,
  };
  onTrace({ kind: 'stage', label: 'frontier resourced', detail: { pathId, ...result } });
  console.log('[map-ensure-frontier] done', { pathId, topic, ...result });
  return result;
}
