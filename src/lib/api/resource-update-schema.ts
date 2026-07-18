// Zod schema for the resource-update API — PATCH /api/playground/resources.
// Sibling to pending-review-schema.ts, but a THIRD axis: that one curates
// approval status and decomposition-review-schema.ts curates shape; this one
// corrects a row's *metadata* (any status — the review skill fixes pending rows,
// the cleanup/audit block reuses it on active ones).
//
// The field whitelist is deliberate — everything else is owned elsewhere:
//   url                          — the row's identity (unique); a different URL is
//                                  a different resource, not an edit.
//   status / decompositionStatus — owned by the review and decompose lifecycles
//                                  (pending-resources / decomposition-review APIs).
//   type                         — a type flip changes router classification;
//                                  that's a re-decompose decision, not an edit.
//
// Primary consumer: the review-pending-resources skill correcting durationMin —
// for text resources it is an unverified discovery-time LLM guess from search
// snippets, yet real gates trust it (the MAX_ATTACHABLE_DURATION_MIN attach
// ceiling, the containment park, duration ranking, the track time allocator).
// The reviewer already has the page open, so it corrects the guess against
// observed reality. Bounds match the discovery clamp (web-fallback.ts).

import { z } from 'zod';

export const resourceUpdateSchema = z.object({
  resourceId: z.string().trim().min(1),
  fields: z
    .strictObject({
      durationMin: z.number().int().min(1).max(6000),
      title: z.string().trim().min(1),
      summary: z.string().trim().min(10),
      difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
    })
    .partial()
    .refine((f) => Object.keys(f).length > 0, {
      message: 'At least one editable field is required.',
    }),
});

export type ResourceUpdateInput = z.infer<typeof resourceUpdateSchema>;
