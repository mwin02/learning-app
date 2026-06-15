// Phase 2.5d-1: the spine author — the generation stage of the map-builder.
//
// Unlike the curriculum agent (retrieval-first: gather library candidates, then
// select), the map-builder is generation-first: there is no library of concepts
// to retrieve, so the model authors the topic's spine — the required backbone of
// its concept map — from its own knowledge as a small prerequisite DAG. Candidate
// resources get attached to these concepts in a later block (2.5d-2); here we
// only produce + (in build-spine.ts) validate the concept/edge structure.
//
// This is a no-tools structured call (Output.object), the same shape the AR
// select stage uses to sidestep the Gemini "tools + Output.object yields nothing"
// limitation. On a repair pass the caller threads the prior attempt's defects in
// as `repairFeedback` so the model fixes its own DAG rather than starting over.

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';
import { SPINE_MIN_CONCEPTS, SPINE_MAX_CONCEPTS } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';
import type { AuthoredSpine } from '@/lib/agents/map/cycle';

export type AuthorSpineArgs = {
  topic: string;
  // The subject domain ({math, science, cs}) from the topic gate, when known —
  // grounds the model on the right kind of decomposition. Optional: the seed
  // path (2.5d-4) knows it; an ad-hoc call may not.
  subject?: string;
  // Defects from the previous attempt, formatted by build-spine.ts. Present only
  // on a repair pass.
  repairFeedback?: string;
  onTrace?: OnTrace;
};

// Deliberately permissive: the constraints the deterministic validator
// (cycle.ts) owns — concept count range, kebab-case/empty slugs, and edge
// endpoint integrity — are intentionally NOT enforced here. If Output.object's
// Zod parse rejected those, an out-of-range or malformed spine would throw at
// parse time and bypass the bounded repair loop, aborting the whole build
// instead of feeding the specific defect back to the author. So the schema only
// pins the structural shape; validateSpine produces actionable defects that
// drive repair. (`title.min(2)` stays as a cheap shape guard the validator does
// not cover; a throw here is now caught + retried by build-spine.ts.)
const SpineSchema = z.object({
  concepts: z.array(
    z.object({
      // Becomes Concept.slug. Format (kebab-case, non-empty) and uniqueness are
      // validated by validateSpine, not here — see the note above.
      slug: z.string(),
      title: z.string().min(2),
    }),
  ),
  edges: z.array(
    z.object({
      fromSlug: z.string(),
      toSlug: z.string(),
    }),
  ),
});

export async function authorSpine(args: AuthorSpineArgs): Promise<AuthoredSpine> {
  const { topic, subject, repairFeedback, onTrace = () => {} } = args;
  const { model, temperature, maxOutputTokens, modelId } = getModel('mapSpineAuthor');

  onTrace({
    kind: 'stage',
    label: repairFeedback ? 'spine repair started' : 'spine author started',
    detail: { topic, subject, repair: Boolean(repairFeedback) },
  });

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: SpineSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildPrompt({ topic, subject, repairFeedback }),
  });

  // TODO(observability): fold into the structured logger when it lands (see the
  // matching note in curriculum-agent.ts).
  console.log('[map-spine-author]', {
    topic,
    modelId,
    repair: Boolean(repairFeedback),
    concepts: result.experimental_output.concepts.length,
    edges: result.experimental_output.edges.length,
    usage: result.usage,
    finishReason: result.finishReason,
  });

  const parsed = result.experimental_output;
  onTrace({
    kind: 'stage',
    label: 'spine author done',
    detail: {
      concepts: parsed.concepts.length,
      edges: parsed.edges.length,
      totalTokens: result.usage?.totalTokens,
    },
  });
  return parsed;
}

const SYSTEM_PROMPT = `You are the spine author of a curriculum map-builder. Given a topic, you decompose it into the SPINE of its concept map: the required backbone of concepts a learner must master to be competent in the topic, plus the prerequisite relationships between them.

This is NOT a reading list and NOT a schedule. You are authoring a concept graph that every future learner's plan will traverse, so it must be correct and stable.

Concepts:
- Output between ${SPINE_MIN_CONCEPTS} and ${SPINE_MAX_CONCEPTS} concepts. The spine is the REQUIRED backbone only — exclude optional enrichment, niche subtopics, and tooling. Those are added later as a separate "frontier".
- OPEN with a foundational onboarding concept at the root — an orientation on-ramp every later concept builds on, so an absolute beginner is never dropped cold into a hard idea. It covers what the subject is, the core mental model, and (as the subject warrants) how to set up / run / read it: for a programming topic, "Getting Started: what it is, environment setup, your first program"; for a math topic, the conceptual big picture, notation, and prerequisite review (NOT tooling). It is a real teachable concept (not a preface), has no prerequisites of its own, and is a prerequisite of the first substantive concept(s). Skip it only when the topic genuinely has no meaningful on-ramp.
- Each concept is one coherent, teachable idea — coarse enough to map to real lessons, not a single fact and not a whole sub-field. Crucially, do NOT bundle several distinct ideas into one concept: a node like "Linear Independence, Basis, and Dimension" or "Symmetric Matrices and Singular Value Decomposition" is too coarse — no single resource teaches all of it, so it can't be covered. Split such bundles into one concept per idea (e.g. linear-independence → basis → dimension) with the right prerequisite edges between them. A title that lists multiple ideas (with "and"/commas) is a sign you should split. This applies EVEN to elementary, foundational basics that are often mentioned together: "Variables, Data Types, and Operators" must be separate concepts (e.g. variables-and-data-types → operators-and-expressions), not one node — a single intro resource rarely teaches all of them at depth. When in doubt, prefer the FINER split: one idea per concept.
- \`slug\`: stable, kebab-case, unique (e.g. "variables-and-types", "list-comprehensions"). The slug is an identity that later passes match against, so make it descriptive and canonical.
- \`title\`: a short human-readable name.

Prerequisite edges:
- Each edge \`{fromSlug, toSlug}\` means "learn \`from\` before \`to\`" — \`from\` is the prerequisite, \`to\` depends on it.
- The edges MUST form a Directed Acyclic Graph: no concept may be, directly or transitively, its own prerequisite. Order from foundational to advanced.
- Add an edge only for a genuine, direct prerequisite. Do not add an edge between two concepts that are merely related, and do not add transitive shortcuts (if A→B and B→C, you need not also state A→C).
- Every slug referenced in an edge must be one of the concepts you listed.`;

function buildPrompt(args: {
  topic: string;
  subject?: string;
  repairFeedback?: string;
}): string {
  const { topic, subject, repairFeedback } = args;
  const lines = [
    `Topic: ${topic}`,
    `Subject domain: ${subject?.trim() ? subject : '(unspecified)'}`,
    '',
    `Author the spine concept map for this topic: ${SPINE_MIN_CONCEPTS}–${SPINE_MAX_CONCEPTS} backbone concepts and the directed prerequisite edges between them, as a DAG.`,
  ];
  if (repairFeedback?.trim()) {
    lines.push(
      '',
      'Your previous attempt was rejected. Fix exactly these defects and return the full corrected spine (not a diff):',
      repairFeedback.trim(),
    );
  }
  return lines.join('\n');
}
