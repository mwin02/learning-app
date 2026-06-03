// Phase 2.5b — concept tagging for decomposed children (decision A).
//
// When a container is exploded into atomic children, each child re-derives its
// OWN conceptsTaught/prerequisiteConcepts from its own title + description —
// not an inherited slice of the parent's concepts — because cross-resource
// dedup at track time (2.5c) keys on accurate per-unit concepts. Derivation is
// grounded on the topic's existing vocabulary so new tags collapse onto tags
// already in use rather than fragmenting the library (same principle as the
// web-fallback tag canonicalizer, but it derives from content rather than
// normalizing pre-supplied tags).
//
// loadTopicVocab lives here (rather than in web-fallback) because both the
// fallback canonicalizer and this derivation step ground on the same per-topic
// vocabulary.

import { generateObject } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/ai/models';
import { CONCEPT_DERIVATION_CHUNK_SIZE } from '@/lib/config';

// The distinct concept tags already in use by a topic — the vocabulary new tags
// are grounded against. Includes pending_review rows so freshly-found resources
// contribute their tags before promotion.
export async function loadTopicVocab(topic: string): Promise<string[]> {
  const rows = await prisma.resource.findMany({
    where: { topic, status: { in: ['active', 'pending_review'] } },
    select: { conceptsTaught: true, prerequisiteConcepts: true },
  });
  const set = new Set<string>();
  for (const r of rows) {
    for (const t of r.conceptsTaught) set.add(t);
    for (const t of r.prerequisiteConcepts) set.add(t);
  }
  return [...set].sort();
}

export type DerivableItem = { ref: string; title: string; description: string };
export type DerivedConcepts = { prerequisiteConcepts: string[]; conceptsTaught: string[] };

const DerivedSchema = z.object({
  results: z.array(
    z.object({
      ref: z.string(),
      prerequisiteConcepts: z.array(z.string()),
      conceptsTaught: z.array(z.string()).min(1),
    }),
  ),
});

const DERIVE_SYSTEM_PROMPT = `You assign concept tags to individual videos that make up a single learning playlist on one topic.

For each video, infer what it actually TEACHES from its own title and description — not from the playlist as a whole.

Rules:
- Return one results entry per input video, keyed by its "ref".
- conceptsTaught: 1-6 concepts the video teaches. prerequisiteConcepts: 0-4 concepts a learner should already know.
- If an existing-vocabulary tag clearly names the same concept (any phrasing/casing/separator), reuse it verbatim. Otherwise normalize to lowercase, hyphen-separated, no surrounding punctuation (e.g. "list-comprehensions").
- Be specific and conservative: tag what the title/description supports; do not invent coverage. Do not collapse distinct concepts onto one tag just because they're related.
- Drop empty/whitespace-only tags.`;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Returns a map ref → derived concepts. Refs absent from the model's output are
// simply omitted; the caller decides the fallback (it has the parent's tags).
export async function deriveChildConcepts(args: {
  topic: string;
  parentConcepts: string[];
  items: DerivableItem[];
}): Promise<Map<string, DerivedConcepts>> {
  const { topic, parentConcepts, items } = args;
  const out = new Map<string, DerivedConcepts>();
  if (items.length === 0) return out;

  const vocab = await loadTopicVocab(topic);
  const grounding = [...new Set([...vocab, ...parentConcepts])].sort();

  for (const batch of chunk(items, CONCEPT_DERIVATION_CHUNK_SIZE)) {
    const { model, temperature, maxOutputTokens } = getModel('conceptDeriver');
    try {
      const result = await generateObject({
        model,
        temperature,
        maxOutputTokens,
        schema: DerivedSchema,
        system: DERIVE_SYSTEM_PROMPT,
        prompt: [
          `Topic: ${topic}`,
          '',
          'Existing topic vocabulary (reuse these tags where they fit):',
          grounding.length > 0 ? JSON.stringify(grounding) : '(none yet)',
          '',
          'Videos to tag:',
          JSON.stringify(
            batch.map((it) => ({ ref: it.ref, title: it.title, description: it.description.slice(0, 500) })),
            null,
            2,
          ),
        ].join('\n'),
      });
      for (const r of result.object.results) {
        out.set(r.ref, {
          prerequisiteConcepts: r.prerequisiteConcepts,
          conceptsTaught: r.conceptsTaught,
        });
      }
    } catch (err) {
      console.log('[concepts] derivation batch failed', { topic, batchSize: batch.length, error: (err as Error).message });
      // Leave this batch's refs unmapped; caller falls back to parent concepts.
    }
  }

  return out;
}
