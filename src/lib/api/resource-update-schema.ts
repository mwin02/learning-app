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
//
// `type` IS editable, and the safety argument for that is the row's decomposition
// status — enforced in update-resource.ts, not here: only an `atomic` row may be
// retyped. A stored type is a candidate signal for whether a page gets *examined*
// for containment, never the verdict (router.ts owns that decision and reaches it
// by fetching the page), and an atomic row is already in the never-examined
// state, so correcting its label there changes nothing that has been acted on. On
// a container the same edit would contradict a shape decision already carried out
// against real children — that is `action: 'decompose'`'s business, not an edit's.
// The two permitted targets are scope rather than safety: `article | video` is
// what the resource standard's clause 6 needs to repair a mislabelled single
// lesson, and a container-type target additionally interacts with the book
// duration floor and whole-work containment, where decompose is the right tool.
//
// One interaction to carry, recorded here deliberately instead of guarded in
// code: a row retyped to `article` (or `video`) short-circuits a LATER
// `action: 'decompose'` — that route's decompose() calls classify(), which routes
// a non-container type straight to atomic without fetching the page. `force` does
// NOT lift this, and assuming it does is the easy mistake: classify() runs first
// and the atomic branch returns before `force` is ever read (decompose.ts's
// route()). `force` vouches for exploding an oversize container past
// DECOMPOSITION_MAX_AUTO_CHILDREN — a different gate, reached only once a router
// is already running. The path that ignores classification altogether is
// `action: 'decompose_manual'`, whose child list is supplied rather than derived
// (manual.ts, the escape hatch for SPA containers the scrapers cannot see). So
// for anyone holding both intentions the rule is ordering: decompose first,
// re-type the leftovers after.
//
// Primary consumer: the review-pending-resources skill correcting durationMin —
// for text resources it is an unverified discovery-time LLM guess from search
// snippets, yet real gates trust it (the MAX_ATTACHABLE_DURATION_MIN attach
// ceiling, the containment park, duration ranking, the track time allocator).
// The reviewer already has the page open, so it corrects the guess against
// observed reality. Bounds match the discovery clamp (web-fallback.ts). `null` is
// permitted and means "nobody has measured this; re-measure me" — the state a
// retyped row needs when the number it carried belonged to the wrong form. It is
// a retraction, not a measurement, so update-resource.ts stamps it `unknown`
// rather than `reviewer`.

import { z } from 'zod';

// Exported so a form can reject an out-of-range duration in the operator's own
// words instead of posting it and reading back a generic validation failure.
export const MAX_EDITABLE_DURATION_MIN = 6000;

// The only types an edit may set. Shared with update-resource.ts so the lib's
// field type and this schema cannot drift apart.
export const RETYPEABLE_TYPES = ['article', 'video'] as const;

export const resourceUpdateSchema = z.object({
  resourceId: z.string().trim().min(1),
  fields: z
    .strictObject({
      durationMin: z.number().int().min(1).max(MAX_EDITABLE_DURATION_MIN).nullable(),
      title: z.string().trim().min(1),
      summary: z.string().trim().min(10),
      difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
      requiresPurchase: z.boolean(),
      type: z.enum(RETYPEABLE_TYPES),
    })
    .partial()
    .refine((f) => Object.keys(f).length > 0, {
      message: 'At least one editable field is required.',
    }),
});

export type ResourceUpdateInput = z.infer<typeof resourceUpdateSchema>;
