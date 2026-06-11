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
]);

export type MapEditInput = z.infer<typeof mapEditSchema>;
