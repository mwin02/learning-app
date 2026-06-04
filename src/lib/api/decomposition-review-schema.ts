// Zod schema for POST /api/playground/decomposition-review — the internal
// curation API that applies a review decision to a queued container resource.
// Lives in its own file so the route handler imports a validated body type
// without the schema leaking elsewhere (mirrors generate-path-schema.ts).
//
// action:
//   accept_atomic — keep the container whole as a pickable atomic unit
//   reject        — keep as an unpickable record (leaves the queue), not crawled
//   decompose     — run the decomposition pipeline against the existing parent
// force: only meaningful for `decompose` — bypass the DECOMPOSITION_MAX_AUTO_CHILDREN
//   oversize gate (a legit mega-course the operator/agent has decided to explode
//   fully). Ignored by the other actions.

import { z } from 'zod';

export const decompositionReviewSchema = z.object({
  resourceId: z.string().trim().min(1),
  action: z.enum(['accept_atomic', 'reject', 'decompose']),
  force: z.boolean().default(false),
});

export type DecompositionReviewInput = z.infer<typeof decompositionReviewSchema>;
