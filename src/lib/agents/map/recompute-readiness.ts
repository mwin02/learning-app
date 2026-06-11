// Phase 2.5d-6: DB-backed readiness recompute — the persistent counterpart to the
// pure computeReadiness (readiness.ts). ensurePathMap (2.5d-3) computed readiness
// once, from the in-memory attachment plan it had just built. Any later mutation
// of a persisted map — the edit API here, the async thickener (2.5j), the reject
// pipeline's candidate-deprecation (2.5f) — needs to recompute it from the rows on
// disk. So this loads the Path's spine concepts + their ConceptResource links,
// reshapes them into the ConceptAttachment shape the pure policy already speaks,
// and writes back Path.status.
//
// It trusts each link's stored role + coverageScore (it does NOT re-check that the
// underlying Resource is still pickable). The edit API enforces pickability at
// attach time, so the links are pickable when written; reacting to a resource that
// later becomes non-pickable (hard-deprecation) is explicitly the 2.5j/2.5f
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
      resources: { select: { resourceId: true, role: true, coverageScore: true } },
    },
  });

  const attachments: ConceptAttachment[] = concepts.map((c) => ({
    conceptSlug: c.slug,
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
