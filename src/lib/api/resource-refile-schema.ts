// Zod schema for the reviewer refile API — POST /api/playground/resource-refile.
//
// A FOURTH axis alongside the three sibling schemas: pending-review-schema.ts
// curates approval, decomposition-review-schema.ts curates shape,
// resource-update-schema.ts corrects metadata — and this one corrects *filing*.
//
// `topic` is deliberately absent from resourceUpdateSchema's whitelist and stays
// absent (Q9): `Resource.topic` is a denormalized mirror of the primary
// ResourceTopic membership, so writing it as a metadata field would rot the mirror.
// The correction goes through `setPrimaryTopic` — via refileToTopic, which also
// refuses a slug the topic registry has never seen — and this is the boundary in
// front of it. Free text rather than an enum because the registry (curated ∪
// learned) is a DB table, not a compile-time list; canonicalization and the
// membership check happen server-side.

import { z } from 'zod';

export const resourceRefileSchema = z.object({
  resourceId: z.string().trim().min(1),
  topic: z.string().trim().min(1),
});

export type ResourceRefileInput = z.infer<typeof resourceRefileSchema>;
