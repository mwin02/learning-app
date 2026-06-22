// Zod schema for the pending-review (status-approval) API — POST
// /api/playground/pending-resources. Sibling to decomposition-review-schema.ts,
// but a DIFFERENT axis: that one curates a resource's *shape* (atomic vs
// container, via decompositionStatus); this one curates its *approval* status
// (pending_review → active, or → deprecated). The two are orthogonal — a row can
// be queued on both at once.
//
// A discriminated union on `action` so a caller (human button or autonomous
// review agent) gets a precise, self-describing contract:
//   approve — pending_review → active (the row becomes pickable by future runs)
//   reject  — pending_review OR active → deprecated, AND its ConceptResource
//             candidate links are deleted from every concept map, with each
//             affected Path's readiness recomputed (2.5g-5). `reject` accepts an
//             *active* target on purpose: a child approved earlier can later be
//             found broken (dead link) and pulled, dropping it from the maps'
//             candidate pools. `severity` records WHY: 'soft' (quality downgrade)
//             vs 'hard' (broken/dead link); persisted on the row for audit. Note:
//             reject reaches the Path side only — immutable Track snapshots are not
//             touched and may keep pointing at the deprecated row.
//
// `cascade` walks the whole decomposition subtree (multi-level: containers can
// hold container children), so "approve all children of this container" /
// "reject this entire tree" is one call. cascade=false acts on the single id —
// e.g. approve/reject one child of a still-pending container.

import { z } from 'zod';

const resourceId = z.string().trim().min(1);

export const pendingReviewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), resourceId, cascade: z.boolean().default(false) }),
  z.object({
    action: z.literal('reject'),
    resourceId,
    cascade: z.boolean().default(false),
    severity: z.enum(['soft', 'hard']).default('soft'),
  }),
]);

export type PendingReviewInput = z.infer<typeof pendingReviewSchema>;
