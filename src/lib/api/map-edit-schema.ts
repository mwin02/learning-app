// Zod schema for POST /api/playground/map-edit — the internal map-curation API
// that applies a structural edit to a topic's concept map (Phase 2.5d-6). Lives
// in its own file so the route imports a validated body type without the schema
// leaking elsewhere (mirrors decomposition-review-schema.ts).
//
// A discriminated union on `action` so each action carries exactly its own fields
// — an agent (the intended non-human caller) gets a precise, self-describing
// contract rather than a bag of optionals. Structural ops only this block;
// ConceptResource attach/detach/rescore land in 2.5d-6b.
//   add_concept     — add a Concept node (slug unique within the Path)
//   edit_concept    — rename a Concept (slug is the stable key; immutable here)
//   remove_concept  — delete a Concept; its edges + resource links cascade
//   set_membership  — flip a Concept between spine and frontier
//   add_prereq      — add a prerequisite edge from→to (cycle-validated on write)
//   remove_prereq   — drop a prerequisite edge
//   attach_resource — link a pickable Resource to a Concept with a role + score
//                     (operator/agent-supplied; no LLM judge — see 2.5d-6b decision)
//   detach_resource — drop a Concept↔Resource link
//   rescore_resource— change an existing link's role and/or coverageScore

import { z } from 'zod';

const id = z.string().trim().min(1);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case');
const title = z.string().trim().min(1).max(200);
const membership = z.enum(['spine', 'frontier']);
const role = z.enum(['teaches', 'uses', 'assesses']);
// Same 0–1 scale the LLM judge emits (candidate-judge.ts); here it's
// operator/agent-supplied rather than model-derived.
const coverageScore = z.number().min(0).max(1);

// Optional free-text justification an autonomous editor (or human) can attach to
// any edit; echoed back and logged for an audit trail of map mutations.
const reason = z.string().trim().max(1000).optional();

export const mapEditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_concept'), pathId: id, slug, title, membership, reason }),
  z.object({ action: z.literal('edit_concept'), conceptId: id, title, reason }),
  z.object({ action: z.literal('remove_concept'), conceptId: id, reason }),
  z.object({ action: z.literal('set_membership'), conceptId: id, membership, reason }),
  z.object({ action: z.literal('add_prereq'), fromConceptId: id, toConceptId: id, reason }),
  z.object({ action: z.literal('remove_prereq'), fromConceptId: id, toConceptId: id, reason }),
  z.object({ action: z.literal('attach_resource'), conceptId: id, resourceId: id, role, coverageScore, reason }),
  z.object({ action: z.literal('detach_resource'), conceptId: id, resourceId: id, reason }),
  z.object({
    action: z.literal('rescore_resource'),
    conceptId: id,
    resourceId: id,
    role: role.optional(),
    coverageScore: coverageScore.optional(),
    reason,
  }),
  // The cross-field rule lives in a superRefine, not a per-member .refine(): a
  // discriminatedUnion member must be a bare ZodObject, and .refine() wraps it in
  // a ZodEffects the union rejects.
]).superRefine((v, ctx) => {
  // rescore needs at least one mutable field — an empty rescore is a no-op caller bug.
  if (v.action === 'rescore_resource' && v.role === undefined && v.coverageScore === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'rescore_resource requires role and/or coverageScore.',
      path: ['role'],
    });
  }
});

export type MapEditInput = z.infer<typeof mapEditSchema>;
