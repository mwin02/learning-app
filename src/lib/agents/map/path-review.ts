// Pre-Freeze Map Review (Block 1) — the DB edges: load the assembled map for the
// critic, and persist its findings to the PathReview worklist.
//
// loadAssembledMap builds the AssembledMap the pure critic reasons over (every
// concept + its chosen primary, every edge). writePathReview persists the findings
// IDEMPOTENTLY: it replaces the OPEN (resolved=false) rows for the Path and leaves
// resolved rows untouched, so a backfill re-review (Block 2) never accumulates
// duplicates and never clobbers an operator's decision (Block 3). No mutation of
// the map or Path.status here — the review is detect-and-flag only.

import { prisma } from '@/lib/db';
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
