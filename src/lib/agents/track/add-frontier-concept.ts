// Phase 2.5f-6: on-demand frontier-concept enrichment.
//
// A learner can want a specialized concept that isn't on a topic's spine (the
// required backbone) — e.g. "reinforcement learning" on the machine-learning map.
// This adds it as a FRONTIER concept (optional enrichment, not required spine),
// wires it into the DAG, and resources it. Frontier concepts never gate
// `spine_ready` (computeReadiness is spine-only), so this can't break the gate.
//
// One LLM call does dedup + relevance + authoring together: given the topic, the
// free-text request, and the existing concepts, it decides
//   exists      → the request already maps to a concept (return it, no dup)
//   irrelevant  → not a genuine specialization of this topic (decline)
//   create      → a new frontier node { slug, title, prerequisiteSlugs }
// The new node is a pure SINK — edges run existing → new only — so it's trivially
// acyclic and can never become a spine prerequisite (the downward-closed invariant).
//
// Resourcing: attach from the existing library first; only if that yields no
// qualifying `teaches` primary do we pay for web sourcing (sourceAndAttachConcept).
//
// The operation is invocable now (scripts/add-frontier.ts); the user-facing
// request trigger is deferred to the request layer (2.5g).

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { ConceptMembership, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/ai/models';
import { attachCandidates } from '@/lib/agents/map/attach-candidates';
import { hasQualifyingPrimary } from '@/lib/agents/map/readiness';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type AddFrontierResult =
  | { outcome: 'created'; conceptSlug: string; resourced: boolean }
  | { outcome: 'exists'; conceptSlug: string }
  | { outcome: 'declined'; reason: string };

const AuthorSchema = z.object({
  decision: z.enum(['exists', 'create', 'irrelevant']),
  // exists: the slug of the existing concept the request maps to.
  existingSlug: z.string().optional(),
  // create: the new frontier node + its direct prerequisites (existing slugs).
  slug: z.string().optional(),
  title: z.string().optional(),
  prerequisiteSlugs: z.array(z.string()).default([]),
  reason: z.string().default(''),
});

export async function addFrontierConcept(args: {
  pathId: string;
  request: string;
}): Promise<AddFrontierResult> {
  const { pathId, request } = args;
  const path = await prisma.path.findUnique({ where: { id: pathId }, select: { topic: true } });
  if (!path) throw new Error(`No Path '${pathId}'.`);

  const concepts = await prisma.concept.findMany({
    where: { pathId },
    select: { slug: true, title: true, membership: true },
  });
  const bySlug = new Map(concepts.map((c) => [c.slug, c]));

  const authored = await authorFrontier({ topic: path.topic, request, concepts });
  console.log('[frontier] authored', { pathId, request, decision: authored.decision });

  if (authored.decision === 'irrelevant') {
    return { outcome: 'declined', reason: authored.reason || 'not a relevant specialization of this topic' };
  }
  if (authored.decision === 'exists') {
    const slug = authored.existingSlug ?? '';
    if (bySlug.has(slug)) return { outcome: 'exists', conceptSlug: slug };
    return { outcome: 'declined', reason: `dedup matched an unknown concept '${slug}'` };
  }

  // --- create ---------------------------------------------------------------
  const slug = (authored.slug ?? '').trim();
  const title = (authored.title ?? '').trim();
  if (!SLUG_PATTERN.test(slug) || title.length < 2) {
    return { outcome: 'declined', reason: `authored an invalid concept (slug='${slug}', title='${title}')` };
  }
  // Defensive dedup: an authored slug that collides with an existing concept is a
  // missed dedup — return the existing node rather than 409 on the unique index.
  if (bySlug.has(slug)) return { outcome: 'exists', conceptSlug: slug };

  // Prerequisites must be existing concepts; silently drop any the model invented.
  const validPrereqs = [...new Set(authored.prerequisiteSlugs)].filter((s) => s !== slug && bySlug.has(s));

  let conceptId: string;
  try {
    conceptId = await prisma.$transaction(async (tx) => {
      const node = await tx.concept.create({
        data: { pathId, slug, title, membership: ConceptMembership.frontier },
        select: { id: true },
      });
      if (validPrereqs.length > 0) {
        const prereqRows = await tx.concept.findMany({
          where: { pathId, slug: { in: validPrereqs } },
          select: { id: true },
        });
        // Edges run prereq → new node only: the frontier node is a sink, so no
        // cycle is possible and the spine stays downward-closed.
        await tx.conceptPrereq.createMany({
          data: prereqRows.map((p) => ({ pathId, fromConceptId: p.id, toConceptId: node.id })),
          skipDuplicates: true,
        });
      }
      return node.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { outcome: 'exists', conceptSlug: slug };
    }
    throw err;
  }

  // --- resource it: existing library first, web sourcing only if still a hole --
  const [attachment] = await attachCandidates({ topic: path.topic, concepts: [{ slug, title }] });
  if (attachment && attachment.candidates.length > 0) {
    await prisma.conceptResource.createMany({
      data: attachment.candidates.map((c) => ({
        conceptId,
        resourceId: c.resourceId,
        role: c.role,
        coverageScore: c.coverageScore,
      })),
      skipDuplicates: true,
    });
  }
  if (!attachment || !hasQualifyingPrimary(attachment)) {
    await sourceAndAttachConcept({ pathId, topic: path.topic, conceptId, slug, title });
  }

  // Report the true end state: does the node have a qualifying `teaches` primary?
  const finalLinks = await prisma.conceptResource.findMany({
    where: { conceptId },
    select: { resourceId: true, role: true, coverageScore: true },
  });
  const resourced = hasQualifyingPrimary({ conceptSlug: slug, candidates: finalLinks });

  console.log('[frontier] created', { pathId, slug, prereqs: validPrereqs, links: finalLinks.length, resourced });
  return { outcome: 'created', conceptSlug: slug, resourced };
}

// ── author ────────────────────────────────────────────────────────────────────

async function authorFrontier(args: {
  topic: string;
  request: string;
  concepts: { slug: string; title: string; membership: ConceptMembership }[];
}): Promise<z.infer<typeof AuthorSchema>> {
  const { topic, request, concepts } = args;
  const { model, temperature, maxOutputTokens, modelId } = getModel('mapSpineAuthor');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: AuthorSchema }),
    system: SYSTEM_PROMPT,
    prompt: [
      `Topic: ${topic}`,
      `Learner's requested concept (free text): "${request}"`,
      '',
      'Existing concepts on the map (slug — title [membership]):',
      JSON.stringify(concepts.map((c) => ({ slug: c.slug, title: c.title, membership: c.membership })), null, 2),
    ].join('\n'),
  });

  console.log('[frontier-author]', { topic, modelId, usage: result.usage, finishReason: result.finishReason });
  return result.experimental_output;
}

const SYSTEM_PROMPT = `You curate a topic's concept map. A learner has requested a specialized concept by free text. Decide how to handle it.

Return one of three decisions:
- "exists": the request already maps to a concept on the map (same idea, different phrasing). Set existingSlug to that concept's slug. Prefer this whenever there is a clear match — do not create duplicates.
- "irrelevant": the request is NOT a genuine concept within this topic (off-topic, nonsense, or too vague to be a teachable concept). Set reason. Be reasonably permissive: a real, more-specialized subtopic of the topic is relevant even if advanced or niche.
- "create": a genuine, more-specialized concept that is not yet on the map. Provide:
  - slug: new, kebab-case, unique, descriptive (e.g. "reinforcement-learning", "gradient-boosting").
  - title: short human-readable name.
  - prerequisiteSlugs: the EXISTING concept slugs (from the list given) that are direct prerequisites a learner needs before this concept. Choose only genuine, direct prerequisites; pick from the existing slugs only; omit transitive/indirect ones. An empty list is acceptable if it builds directly on nothing already on the map.

This concept will be added as a FRONTIER concept — optional enrichment beyond the required backbone — so it is fine for it to be specialized or advanced. Never invent prerequisite slugs that are not in the provided list.`;
