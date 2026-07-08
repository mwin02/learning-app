// Pre-Freeze Map Review (Block 1) — the DB edges: load the assembled map for the
// critic, and persist its findings to the PathReview worklist.
//
// loadAssembledMap builds the AssembledMap the pure critic reasons over (every
// concept + its chosen primary, every edge). writePathReview persists the findings
// IDEMPOTENTLY: it replaces the OPEN (resolved=false) rows for the Path and leaves
// resolved rows untouched, so a backfill re-review (Block 2) never accumulates
// duplicates and never clobbers an operator's decision (Block 3). No mutation of
// the map or Path.status here — the review is detect-and-flag only.

import { Prisma, PathReviewResolution } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { planConceptMerge, MergeCycleError } from '@/lib/agents/map/merge-concept';
import { choosePrimary, type AssembledMap, type MapReviewFinding } from '@/lib/agents/map/review-map';

// Load the final assembled map (all concepts + edges + each concept's chosen
// primary). Reads only — never mutates.
export async function loadAssembledMap(pathId: string): Promise<AssembledMap> {
  const path = await prisma.path.findUniqueOrThrow({
    where: { id: pathId },
    select: { topic: true },
  });
  const concepts = await prisma.concept.findMany({
    where: { pathId },
    select: {
      slug: true,
      title: true,
      membership: true,
      primaryRelaxed: true,
      resources: {
        select: {
          role: true,
          coverageScore: true,
          resource: { select: { title: true } },
        },
      },
    },
  });
  const edges = await prisma.conceptPrereq.findMany({
    where: { pathId },
    select: { from: { select: { slug: true } }, to: { select: { slug: true } } },
  });

  return {
    topic: path.topic,
    concepts: concepts.map((c) => ({
      slug: c.slug,
      title: c.title,
      membership: c.membership,
      primaryRelaxed: c.primaryRelaxed,
      primary: choosePrimary(
        c.resources.map((r) => ({ title: r.resource.title, role: r.role, coverageScore: r.coverageScore })),
      ),
    })),
    edges: edges.map((e) => ({ fromSlug: e.from.slug, toSlug: e.to.slug })),
  };
}

// Persist the findings as the Path's OPEN worklist: drop the prior open rows and
// insert the fresh set, in one transaction. Resolved rows survive (an operator's
// decision is permanent); a Path with no findings simply ends with no open rows.
// Returns the count written.
export async function writePathReview(
  pathId: string,
  findings: MapReviewFinding[],
): Promise<{ written: number }> {
  await prisma.$transaction(async (tx) => {
    await tx.pathReview.deleteMany({ where: { pathId, resolved: false } });
    if (findings.length > 0) {
      await tx.pathReview.createMany({
        data: findings.map((f) => ({
          pathId,
          kind: f.kind,
          conceptSlugs: f.conceptSlugs,
          message: f.message,
        })),
      });
    }
  });
  return { written: findings.length };
}

// The open (unresolved) findings, newest first — the operator worklist. Scoped to
// one Path when pathId is given, else every Path's open findings.
export async function listOpenFindings(pathId?: string) {
  return prisma.pathReview.findMany({
    where: { resolved: false, ...(pathId ? { pathId } : {}) },
    orderBy: { createdAt: 'desc' },
    select: { id: true, pathId: true, kind: true, conceptSlugs: true, message: true, createdAt: true },
  });
}

// Conditionally resolve a finding: the update matches only while it is still open,
// so a concurrent decision (or a re-decide) matches zero rows and loses the race.
// Returns whether THIS call resolved it.
export async function resolveFinding(
  reviewId: string,
  resolution: PathReviewResolution,
  client: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const { count } = await client.pathReview.updateMany({
    where: { id: reviewId, resolved: false },
    data: { resolved: true, resolution },
  });
  return count === 1;
}

// Apply a confirmed duplication merge INSIDE a caller-supplied transaction: repoint
// the loser's resource links + prerequisite edges onto the winner, delete the loser
// (cascading its remaining duplicate links + edges), and recompute readiness so
// Path.status can't disagree with the mutated map. Throws MergeCycleError if the
// merge would create a prerequisite cycle — the caller maps that to a 422 and the
// whole tx (including the finding resolution) rolls back, writing nothing.
export async function applyConceptMerge(
  tx: Prisma.TransactionClient,
  args: { pathId: string; winnerId: string; loserId: string },
): Promise<void> {
  const { pathId, winnerId, loserId } = args;
  const [edges, winnerLinks, loserLinks] = await Promise.all([
    tx.conceptPrereq.findMany({ where: { pathId }, select: { fromConceptId: true, toConceptId: true } }),
    tx.conceptResource.findMany({ where: { conceptId: winnerId }, select: { resourceId: true } }),
    tx.conceptResource.findMany({ where: { conceptId: loserId }, select: { id: true, resourceId: true } }),
  ]);

  const plan = planConceptMerge({
    winnerId,
    loserId,
    edges,
    winnerResourceIds: new Set(winnerLinks.map((l) => l.resourceId)),
    loserResourceLinks: loserLinks,
  });
  if (plan.wouldCycle) throw new MergeCycleError(winnerId, loserId);

  if (plan.resourceLinkIdsToMove.length > 0) {
    await tx.conceptResource.updateMany({
      where: { id: { in: plan.resourceLinkIdsToMove } },
      data: { conceptId: winnerId },
    });
  }
  if (plan.edgesToCreate.length > 0) {
    await tx.conceptPrereq.createMany({
      data: plan.edgesToCreate.map((e) => ({ pathId, ...e })),
      skipDuplicates: true,
    });
  }
  await tx.concept.delete({ where: { id: loserId } });
  await recomputeReadiness(pathId, tx);
}
