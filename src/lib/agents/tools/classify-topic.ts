// Phase 2.5 (Block 2a): discovery-time topic classification.
//
// Web discovery is scoped to a single requesting topic, and the pre-2a behavior
// stamped that request topic onto every find — so a generic JavaScript tutorial
// discovered while building a `javascript-react` path was permanently filed
// under `javascript-react` and invisible to a `javascript` path. This files
// each discovered resource under its true home topic instead.
//
// The choice is CLOSED and BOUNDED: a resource may only be filed under the
// request topic or one of its related topics (relatedTopics(requestTopic)) —
// never an unrelated subject. That bound is the "subject ceiling": a calculus
// find can never be relabeled to linear-algebra because they share no relation.
// When the candidate set has a single member (the common case — only the JS
// pair has a relation today), there is nothing to decide and the caller skips
// this entirely. Any failure or out-of-set answer degrades to the request topic
// (no worse than the pre-2a behavior), mirroring the canonicalizer's resilience.

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';

export type ClassifiableResource = {
  url: string;
  title: string;
  summary: string;
  conceptsTaught: string[];
};

const ClassificationSchema = z.object({
  results: z.array(z.object({ url: z.string().url(), topic: z.string() })),
});

// Returns url -> filed topic for the resources it could confidently place.
// A url absent from the map (or any failure) means the caller should fall back
// to the request topic. Topics outside `candidates` are dropped, not trusted.
export async function classifyDiscoveryTopics(
  resources: ClassifiableResource[],
  candidates: string[],
  fallback: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // Nothing to decide: a single candidate (or none) means every resource is the
  // request topic. Callers already guard on this, but keep the function honest.
  if (resources.length === 0 || candidates.length <= 1) return map;

  const allowed = new Set(candidates);
  const { model, temperature, maxOutputTokens } = getModel('topicClassifier');

  const input = resources.map((r) => ({
    url: r.url,
    title: r.title,
    summary: r.summary,
    conceptsTaught: r.conceptsTaught,
  }));

  try {
    const result = await generateObject({
      model,
      temperature,
      maxOutputTokens,
      schema: ClassificationSchema,
      system: CLASSIFY_SYSTEM_PROMPT,
      prompt: [
        'Candidate topics (choose exactly one per resource, by slug):',
        JSON.stringify(candidates),
        `If a resource does not clearly fit a more specific topic, choose "${fallback}".`,
        '',
        'Resources to file:',
        JSON.stringify(input, null, 2),
      ].join('\n'),
    });

    for (const r of result.object.results) {
      // Trust only in-set answers; anything else degrades to the request topic
      // by virtue of being left out of the map.
      if (allowed.has(r.topic)) map.set(r.url, r.topic);
    }
  } catch (err) {
    console.warn('[classify-topic] classification failed, filing under request topic', {
      count: resources.length,
      candidates,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return map;
}

const CLASSIFY_SYSTEM_PROMPT = `You file a freshly discovered learning resource under its home topic, chosen from a fixed list of candidate topic slugs.

Rules:
- Return one entry per input resource, keyed by its url, with a "topic" equal to one of the candidate slugs exactly.
- Choose the most SPECIFIC candidate the resource squarely belongs to. A specialization slug (e.g. "javascript-react") is for resources that actually teach or require that specialization; a foundational slug (e.g. "javascript") is for resources covering only the general subject.
- When a resource covers only the foundational subject and does NOT require the specialization, choose the foundational topic — even though it was discovered while building the specialization's library.
- Be conservative: when genuinely unsure which candidate fits, choose the fallback topic given in the prompt rather than guessing.`;
