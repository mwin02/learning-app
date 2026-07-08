// Zod schema for POST /api/playground/map-review — the operator worklist API that
// applies a decision to a PathReview finding (Pre-Freeze Map Review, Block 3).
// Mirrors decomposition-review-schema.ts: a discriminated union on `action` so each
// action carries exactly its own fields and an agent caller gets a precise contract.
//
//   merge   — collapse a `duplication` finding's two concepts into one. The caller
//             names the WINNER (the survivor) by slug; the finding's other concept
//             is the loser, whose edges/resources repoint onto the winner before it
//             is deleted. Only valid for a duplication finding.
//   dismiss — not a real problem; resolve with no mutation.
//   keep    — a real finding intentionally left as-is for now; resolve, no mutation.

import { z } from 'zod';

const reviewId = z.string().trim().min(1);

export const mapReviewActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('merge'), reviewId, winnerSlug: z.string().trim().min(1) }),
  z.object({ action: z.literal('dismiss'), reviewId }),
  z.object({ action: z.literal('keep'), reviewId }),
]);

export type MapReviewActionInput = z.infer<typeof mapReviewActionSchema>;
