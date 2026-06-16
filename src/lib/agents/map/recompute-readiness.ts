// Phase 2.5d-6: DB-backed readiness recompute — the persistent counterpart to the
// pure computeReadiness (readiness.ts). ensurePathMap (2.5d-3) computed readiness
// once, from the in-memory attachment plan it had just built. Any later mutation
// of a persisted map — the edit API here, the async thickener (2.5f), the reject
// pipeline's candidate-deprecation (2.5g) — needs to recompute it from the rows on
// disk. So this loads the Path's spine concepts + their ConceptResource links,
// reshapes them into the ConceptAttachment shape the pure policy already speaks,
// and writes back Path.status.
//
// It trusts each link's stored role + coverageScore (it does NOT re-check that the
// underlying Resource is still pickable). The edit API enforces pickability at
// attach time, so the links are pickable when written; reacting to a resource that
// later becomes non-pickable (hard-deprecation) is explicitly the 2.5f/2.5g
// reject-pipeline's job, not this structural recompute's.
//
// Status policy: a mutating edit always lands the Path at `spine_ready` (no holes)
// or `building` (≥1 hole, or no spine concepts). This deliberately rescues a
// `failed` map an edit has fixed — a hand-repaired map is no longer broken — and
// never leaves it `draft`.

import { ConceptMembership, PathStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { computeReadiness } from '@/lib/agents/map/readiness';
import type { ConceptAttachment } from '@/lib/agents/map/attach-candidates';

export type RecomputeResult = {
  status: PathStatus;
  // Spine-hole concept slugs (spine concepts with no qualifying `teaches` primary).
  holes: string[];
};

// `client` defaults to the global prisma, but callers that mutate inside a
// transaction (e.g. the map edit API) pass their tx client so the read-back and
// the Path.status write commit atomically with the mutation — the status can
// never disagree with the rows it was computed from.
export async function recomputeReadiness(
  pathId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<RecomputeResult> {
  const concepts = await client.concept.findMany({
    where: { pathId, membership: ConceptMembership.spine },
    select: {
      slug: true,
      primaryRelaxed: true,
      resources: { select: { resourceId: true, role: true, coverageScore: true } },
    },
  });

  const attachments: ConceptAttachment[] = concepts.map((c) => ({
    conceptSlug: c.slug,
    primaryRelaxed: c.primaryRelaxed,
    candidates: c.resources.map((r) => ({
      resourceId: r.resourceId,
      role: r.role,
      coverageScore: r.coverageScore,
    })),
  }));

  const { ready, holes } = computeReadiness(attachments);
  const status = ready ? PathStatus.spine_ready : PathStatus.building;

  await client.path.update({ where: { id: pathId }, data: { status } });
  return { status, holes };
}

// Spine-containment warning (Phase 2.5d-7c): the slugs of spine concepts that have
// a frontier prerequisite. The spine must stay downward-closed — every prerequisite
// of a spine concept must itself be spine — so the Track builder (2.5e) can trim
// unselected frontier nodes without orphaning a required spine concept. A
// `frontier → spine` prereq edge (from.membership = frontier, to.membership = spine)
// violates that, leaving the `to` concept with a dangling prerequisite once trimmed.
// add_prereq hard-blocks the direct case, but a set_membership flip can reintroduce
// it without passing that gate, so callers surface this as a non-blocking warning.
// It deliberately does NOT affect Path.status — only spine holes gate spine_ready.
// One indexed query over the (membership-joined) edge set, deduped by slug.
export async function frontierGatedSpine(
  pathId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  const edges = await client.conceptPrereq.findMany({
    where: { pathId, from: { membership: 'frontier' }, to: { membership: 'spine' } },
    select: { to: { select: { slug: true } } },
  });
  return [...new Set(edges.map((e) => e.to.slug))];
}
