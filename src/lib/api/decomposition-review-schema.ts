// Zod schema for POST /api/playground/decomposition-review — the internal
// curation API that applies a review decision to a queued container resource.
// Lives in its own file so the route handler imports a validated body type
// without the schema leaking elsewhere (mirrors generate-path-schema.ts).
//
// A discriminated union on `action` so each action carries exactly its own
// fields — and so an agent (the intended non-human caller) gets a precise,
// self-describing contract rather than a bag of optionals:
//   accept_atomic   — keep the container whole as a pickable atomic unit
//   reject          — keep as an unpickable record (leaves the queue), not crawled
//   decompose       — run the decomposition pipeline against the existing parent;
//                     force bypasses the DECOMPOSITION_MAX_AUTO_CHILDREN oversize gate
//   decompose_manual — explode the container into the supplied ordered child list
//                     (the SPA escape hatch: Khan-style courses the scraper/LLM
//                     routers can't read, so a human or browser agent supplies the
//                     ordered lessons directly)

import { z } from 'zod';

const resourceId = z.string().trim().min(1);

// One operator/agent-supplied child of a manual decomposition. url + title are
// required; everything else is optional and filled by the manual router
// (concepts derived, type inferred, duration/difficulty defaulted). `type` is
// constrained to the real ResourceType enum — there is deliberately no slot for
// an "exercise", so exercises are dropped at the source.
export const manualChildSchema = z.object({
  url: z.string().trim().url(),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(2000).optional(),
  type: z.enum(['article', 'video', 'course', 'interactive', 'docs', 'book']).optional(),
  durationMin: z.number().int().min(1).max(6000).optional(),
});

export type ManualChildInput = z.infer<typeof manualChildSchema>;

export const decompositionReviewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept_atomic'), resourceId }),
  z.object({ action: z.literal('reject'), resourceId }),
  z.object({ action: z.literal('decompose'), resourceId, force: z.boolean().default(false) }),
  z.object({
    action: z.literal('decompose_manual'),
    resourceId,
    // A decomposition only makes sense with ≥2 children — a single child means
    // the page was atomic, which is `accept_atomic`, not a manual split.
    children: z.array(manualChildSchema).min(2),
  }),
]);

export type DecompositionReviewInput = z.infer<typeof decompositionReviewSchema>;
