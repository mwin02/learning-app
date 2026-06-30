// Pending-review curation — the *status-approval* axis of a Resource
// (pending_review → active | deprecated). Distinct from the decomposition axis
// (src/lib/agents/decomposition/*), which curates a resource's shape. Shared by
// both the agent-facing API (GET/POST /api/playground/pending-resources) and the
// human playground page, so a curator and an autonomous reviewer act on exactly
// the same queue through the same logic.
//
// Why this matters: the web fallback inserts discovered resources as
// `pending_review` and uses them in the very run that found them — so a
// pending_review row can already sit in a persisted Path. The PENDING_REVIEW_GATE
// then hides un-approved rows from *future* runs once a topic's library fills up.
// Approving lifts that gate; rejecting deprecates the row AND drops it from every
// concept map's candidate pool (delete its ConceptResource links), then recomputes
// each affected Path's readiness — the Phase 2.5g-5 cutover of the old PathItem
// flip. Only the Path (the living concept map) is kept accurate; built Tracks are
// immutable snapshots and are NOT touched (they may keep pointing at a now-deprecated
// resource — the row still exists; broken Tracks are triaged manually). See the
// Track immutability note in schema.prisma.

import { PathStatus, BankStaleReason } from '@prisma/client';
import type { ResourceStatus, DecompositionStatus, DeprecationSeverity } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { markBankStale } from '@/lib/agents/content/mark-bank-stale';

// A container whose shape is still unsettled isn't meaningfully approvable —
// flipping its status can't make an unpickable container pickable. These are
// surfaced read-only and routed to the Human review (decomposition) queue.
const UNRESOLVED: DecompositionStatus[] = ['pending', 'human_review'];

// Direct children worth showing under a queued container: still-pending ones to
// approve, plus already-approved ones so a curator can reject a child later
// found broken (dead link) and drop it from existing paths.
const CHILD_STATUSES: ResourceStatus[] = ['pending_review', 'active'];

export type PendingReviewChild = {
  id: string;
  title: string;
  type: string;
  url: string;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
  durationMin: number;
  orderInParent: number | null;
};

export type PendingReviewRoot = {
  id: string;
  title: string;
  topic: string;
  type: string;
  url: string;
  origin: string;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
  updatedAt: Date;
  // True when decompositionStatus is unresolved (pending/human_review): shown
  // but not approvable — resolve on the decomposition axis first.
  blocked: boolean;
  // Direct children only. Multi-level subtrees are handled by cascade at write
  // time, not by rendering every level here.
  children: PendingReviewChild[];
};

// Top-level (parentResourceId === null) resources currently awaiting approval,
// each with its direct children. Ordered oldest-first (createdAt asc) so the
// queue is FIFO — an agent can `take` a bounded batch, process it, then ask for
// the next. `limit` caps the number of top-level roots returned (the unit an
// agent processes); omit it to return the whole queue (the human page).
export async function listPendingReview(limit?: number): Promise<PendingReviewRoot[]> {
  const rows = await prisma.resource.findMany({
    where: { parentResourceId: null, status: 'pending_review' },
    ...(limit !== undefined ? { take: limit } : {}),
    select: {
      id: true,
      title: true,
      topic: true,
      type: true,
      url: true,
      origin: true,
      status: true,
      decompositionStatus: true,
      updatedAt: true,
      children: {
        where: { status: { in: CHILD_STATUSES } },
        select: {
          id: true,
          title: true,
          type: true,
          url: true,
          status: true,
          decompositionStatus: true,
          durationMin: true,
          orderInParent: true,
        },
        orderBy: { orderInParent: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((r) => ({
    ...r,
    blocked: UNRESOLVED.includes(r.decompositionStatus),
  }));
}

export type ApplyResult =
  | { kind: 'approved'; resourceId: string; approved: number }
  | {
      kind: 'rejected';
      resourceId: string;
      deprecated: number;
      // ConceptResource candidate links removed (the deprecated rows dropped from
      // every concept map's candidate pool).
      conceptLinksRemoved: number;
      // Distinct Paths whose readiness was recomputed after the removal.
      pathsRecomputed: number;
      // Of those, how many regressed spine_ready → building (the deprecation
      // reopened a spine hole; the worker refills it on the next request).
      pathsRegressed: number;
    }
  | { kind: 'not_found' }
  | { kind: 'blocked'; decompositionStatus: DecompositionStatus }
  | { kind: 'raced' };

export type ApplyInput =
  | { action: 'approve'; resourceId: string; cascade: boolean }
  | { action: 'reject'; resourceId: string; cascade: boolean; severity: DeprecationSeverity };

// All ids in the decomposition subtree rooted at `rootId` (inclusive). A
// recursive CTE so arbitrarily-deep container-of-container trees collapse in one
// round-trip; Prisma's relation API can't express recursion.
async function subtreeIds(rootId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM "Resource" WHERE id = ${rootId}
      UNION ALL
      SELECT r.id FROM "Resource" r
      JOIN subtree s ON r."parentResourceId" = s.id
    )
    SELECT id FROM subtree
  `;
  return rows.map((row) => row.id);
}

// Apply an approve/reject decision. Conditional updateMany re-asserts the status
// guard at write time, so a concurrent decision that won the race surfaces as
// `raced` (a no-op single-target update) rather than silently clobbering.
export async function applyPendingReview(input: ApplyInput): Promise<ApplyResult> {
  const root = await prisma.resource.findUnique({
    where: { id: input.resourceId },
    select: { id: true, decompositionStatus: true },
  });
  if (!root) return { kind: 'not_found' };
  if (UNRESOLVED.includes(root.decompositionStatus)) {
    return { kind: 'blocked', decompositionStatus: root.decompositionStatus };
  }

  const ids = input.cascade ? await subtreeIds(root.id) : [root.id];

  if (input.action === 'approve') {
    const { count } = await prisma.resource.updateMany({
      where: { id: { in: ids }, status: 'pending_review' },
      data: { status: 'active' },
    });
    // A single-target no-op means the row already left pending_review (raced or
    // re-decided). A cascade legitimately updates 0 when the subtree is already
    // approved, so only the single case is a 409.
    if (!input.cascade && count === 0) return { kind: 'raced' };
    return { kind: 'approved', resourceId: root.id, approved: count };
  }

  // reject: deprecate the resource(s) AND drop them from every concept map's
  // candidate pool, recomputing readiness — all in one transaction so a map's
  // status never disagrees with its candidate rows.
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.resource.updateMany({
      where: { id: { in: ids }, status: { in: ['pending_review', 'active'] } },
      data: { status: 'deprecated', deprecationSeverity: input.severity },
    });
    if (!input.cascade && count === 0) return { kind: 'raced' as const };

    // Path-side candidate-deprecation. recomputeReadiness trusts each link's stored
    // coverage and does NOT re-check resource pickability, so the link MUST be
    // deleted for a reopened spine hole to surface — otherwise the map would keep
    // reporting spine_ready off a deprecated resource. Capture affected Paths
    // BEFORE deleting (the join is gone afterwards).
    const links = await tx.conceptResource.findMany({
      where: { resourceId: { in: ids } },
      select: { conceptId: true, role: true, concept: { select: { pathId: true } } },
    });
    const affectedPathIds = [...new Set(links.map((l) => l.concept.pathId))];

    // Phase 2.5i: deprecation removes these candidate links, so any reviewed bank
    // grounded in them goes stale. A dropped `teaches` link is primary_changed; the
    // rest are resource_removed. markBankStale's no-downgrade rule means a concept
    // losing both a teaches and a non-teaches link lands on primary_changed
    // regardless of order, so we can flag the two groups independently.
    const primaryConcepts = [...new Set(links.filter((l) => l.role === 'teaches').map((l) => l.conceptId))];
    const removedConcepts = [...new Set(links.filter((l) => l.role !== 'teaches').map((l) => l.conceptId))];
    await markBankStale(tx, removedConcepts, BankStaleReason.resource_removed);
    await markBankStale(tx, primaryConcepts, BankStaleReason.primary_changed);

    const { count: conceptLinksRemoved } = await tx.conceptResource.deleteMany({
      where: { resourceId: { in: ids } },
    });

    let pathsRegressed = 0;
    for (const pathId of affectedPathIds) {
      const { status } = await recomputeReadiness(pathId, tx);
      if (status === PathStatus.building) pathsRegressed++;
    }

    return {
      kind: 'rejected' as const,
      resourceId: root.id,
      deprecated: count,
      conceptLinksRemoved,
      pathsRecomputed: affectedPathIds.length,
      pathsRegressed,
    };
  });
}
