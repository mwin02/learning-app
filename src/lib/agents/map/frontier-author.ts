// Frontier authoring (map build): one batch call proposing a topic's FRONTIER —
// the optional enrichment concepts beyond the required spine (applications,
// specializations, adjacent techniques a competent learner reaches next).
//
// The 2026-07-02 audit found every generated map 100% spine: buildSpine authors
// only backbone membership, and the sole frontier entry point was the manual
// learner-request primitive (add-frontier-concept.ts), never run in production.
// With zero frontier the whole mastery-depth machinery — the composer's frontier
// ranking, the allocator's masteryRelevant trim — is dead code. This pass gives
// every map a frontier at build time.
//
// Shape: per-node `prerequisiteSlugs` (edges INTO each new node only), the same
// shape as add-frontier-concept's single-node author. That makes frontier→spine
// edges structurally impossible — a new node can never become a prerequisite of
// an existing concept, so the spine stays downward-closed by construction. The
// only structural risk left is a cycle AMONG the new nodes, which the caller
// (build-frontier.ts) validates and repairs.
//
// Like the spine author, this is a no-tools structured call whose schema is
// deliberately permissive: slug format, dedup against the existing map, and
// prereq integrity are the sanitizer's job (deterministic fixes), not parse-time
// throws that would bypass the repair loop.

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';
import { FRONTIER_MIN_CONCEPTS, FRONTIER_MAX_CONCEPTS } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type AuthoredFrontierConcept = {
  slug: string;
  title: string;
  // Direct prerequisites: existing map slugs, or slugs of other concepts in this
  // same batch (frontier→frontier chains).
  prerequisiteSlugs: string[];
};

export type AuthorFrontierArgs = {
  topic: string;
  subject?: string;
  // The persisted map's concepts (spine + any pre-existing frontier), so the
  // author can anchor prerequisites and avoid duplicating what's already there.
  existing: { slug: string; title: string; membership: string }[];
  // Defects from the previous attempt (a cycle), formatted by build-frontier.ts.
  repairFeedback?: string;
  onTrace?: OnTrace;
};

const FrontierSchema = z.object({
  concepts: z.array(
    z.object({
      slug: z.string(),
      title: z.string().min(2),
      // Required, not .default([]): a defaulted field is marked optional in
      // Gemini's response schema and the model then routinely omits it, leaving
      // frontier nodes dangling (see add-frontier-concept.ts AuthorSchema).
      prerequisiteSlugs: z.array(z.string()),
    }),
  ),
});

export async function authorFrontier(args: AuthorFrontierArgs): Promise<{ concepts: AuthoredFrontierConcept[] }> {
  const { topic, subject, existing, repairFeedback, onTrace = () => {} } = args;
  const { model, temperature, maxOutputTokens, modelId } = getModel('mapSpineAuthor');

  onTrace({
    kind: 'stage',
    label: repairFeedback ? 'frontier repair started' : 'frontier author started',
    detail: { topic, subject, existing: existing.length, repair: Boolean(repairFeedback) },
  });

  const lines = [
    `Topic: ${topic}`,
    `Subject domain: ${subject?.trim() ? subject : '(unspecified)'}`,
    '',
    'Existing concepts on the map (slug — title [membership]):',
    JSON.stringify(existing.map((c) => ({ slug: c.slug, title: c.title, membership: c.membership })), null, 2),
    '',
    `Author the FRONTIER for this map: ${FRONTIER_MIN_CONCEPTS}–${FRONTIER_MAX_CONCEPTS} enrichment concepts with their prerequisites, most important first.`,
  ];
  if (repairFeedback?.trim()) {
    lines.push(
      '',
      'Your previous attempt was rejected. Fix exactly these defects and return the full corrected frontier (not a diff):',
      repairFeedback.trim(),
    );
  }

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: FrontierSchema }),
    system: SYSTEM_PROMPT,
    prompt: lines.join('\n'),
  });

  const parsed = result.experimental_output;
  console.log('[map-frontier-author]', {
    topic,
    modelId,
    repair: Boolean(repairFeedback),
    concepts: parsed.concepts.length,
    usage: result.usage,
    finishReason: result.finishReason,
  });
  onTrace({
    kind: 'stage',
    label: 'frontier author done',
    detail: { concepts: parsed.concepts.length, totalTokens: result.usage?.totalTokens },
  });
  return parsed;
}

const SYSTEM_PROMPT = `You are the frontier author of a curriculum map-builder. A topic's concept map has two memberships: the SPINE (the required backbone every learner masters — already authored, given to you) and the FRONTIER (optional enrichment beyond the backbone). You author the frontier.

Frontier concepts are what a competent learner reaches NEXT: significant applications, important specializations, adjacent techniques, and deeper extensions of the spine. Examples — a calculus spine gains "applications of integration", "transcendental functions", "L'Hôpital's rule"; a machine-learning spine gains "reinforcement learning", "gradient boosting". Learners at higher target mastery see more frontier; lower targets see less — so rank matters: order your list MOST important enrichment first.

Rules:
- Output between ${FRONTIER_MIN_CONCEPTS} and ${FRONTIER_MAX_CONCEPTS} frontier concepts. Cover the topic's genuinely important enrichment — not exhaustive trivia, not tooling minutiae.
- Do NOT duplicate an existing concept (same idea, different phrasing). Every concept you output must be genuinely new to the map.
- Each concept is one coherent, teachable idea — coarse enough to map to a real lesson, not a single fact and not a whole sub-field. Do not bundle several ideas into one node (a title with "and"/commas is a sign to split).
- \`slug\`: new, stable, kebab-case, unique (e.g. "applications-of-integration", "gradient-boosting").
- \`title\`: a short human-readable name.
- \`prerequisiteSlugs\`: the DIRECT prerequisites a learner must understand first. Pick from the existing map slugs given, or from other new concepts in THIS output (a frontier chain). A real enrichment almost always builds on the spine, so anchor each concept under its closest foundation — an empty list is rare and means the concept genuinely has no prerequisite on the map. Prefer immediate prerequisites; omit distant/transitive ones. Never invent a slug that is neither existing nor in your own output.
- The prerequisite relationships among your NEW concepts must be acyclic: no new concept may be, directly or transitively, its own prerequisite.`;
