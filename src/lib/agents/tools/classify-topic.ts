// Phase 2.5 (Block 2a) — discovery-time topic classification.
// Topic filing T2b — reopened from a CLOSED to an OPEN vocabulary.
//
// Web discovery is scoped to a single requesting topic, and the pre-2a behavior stamped
// that request topic onto every find — so a generic JavaScript tutorial discovered while
// building a `javascript-react` path was permanently filed under `javascript-react` and
// invisible to a `javascript` path. This files each discovered resource under its true
// home topic instead.
//
// ⚠️ What changed in T2b. The 2a design bounded the choice to
// `relatedTopics(requestTopic)` — the "subject ceiling", meant to stop a calculus find
// being relabelled linear-algebra. The bound was the wrong instrument: TOPIC_RELATIONS
// has five keys, so the ceiling also excluded every CORRECT topic that merely lacked an
// edge or did not exist yet, and for topics with no edges the classifier was skipped
// outright — 1,152 of 1,926 rows (60%) were filed with no classification at all.
//
// The vocabulary is now every canonical (`listCanonicals()`), and the ceiling moved to
// EVIDENCE: src/lib/curation/topic-knn.ts tests each proposal against the resource's
// embedding neighbourhood before it becomes a membership. So this function's job shrank
// — it PROPOSES, ranked, and no longer decides. A wrong proposal is caught downstream;
// a proposal that is merely unusual is no longer impossible.
//
// Degradation is unchanged: any failure, or an out-of-vocabulary answer, leaves the url
// out of the map, and the caller files under the request topic exactly as before.

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';

export type ClassifiableResource = {
  url: string;
  title: string;
  summary: string;
  conceptsTaught: string[];
};

// Ranked, most confident first. The guardrail takes the head as the proposed primary and
// tests the tail for secondary memberships, so ORDER is the confidence signal — no
// separate score is asked for, because nothing consumes it: `relevance` is measured k-NN
// purity, not the model's self-assessment.
const MAX_PROPOSALS = 3;

const ClassificationSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().url(),
      topics: z.array(z.string()).min(1).max(MAX_PROPOSALS),
      // Topic filing T3: the ONE place the model may name a slug that is not in the
      // vocabulary — an explicit "this resource's subject does not exist in our library
      // yet" signal. It is a PROPOSAL, not a topic: the caller routes it through the
      // topic gate (curated match / known alias / grounded mint + kebab coercion +
      // T1.5's snap-to-curated-slug), which is free to reject it outright. Without this
      // channel T3's minting is unreachable — every proposal below is filtered to the
      // existing vocabulary, so the classifier can never surface a topic we lack, which
      // is precisely the motivating case (45 Khan "Functions" leaves whose right answer,
      // `algebra`, no code path could utter).
      newTopic: z.string().nullable(),
    }),
  ),
});

export type TopicProposal = {
  // Ranked in-vocabulary proposals, most confident first. Possibly empty.
  topics: string[];
  // A slug the model wants minted, or null. Only meaningful when nothing in `topics`
  // clears the guardrail — evidence about an existing topic always wins over a mint.
  newTopic: string | null;
};

// Returns url -> proposals. A url absent from the map (or any failure) means the caller
// should fall back to the request topic. Topics outside `candidates` are dropped, not
// trusted — the model is grounded on the vocabulary, and a hallucinated slug arriving
// through `topics` would mint a shelf nothing else can reach. `newTopic` is the audited
// exception (see the schema comment).
export async function classifyDiscoveryTopics(
  resources: ClassifiableResource[],
  candidates: string[],
  fallback: string,
): Promise<Map<string, TopicProposal>> {
  const map = new Map<string, TopicProposal>();
  // An empty vocabulary has nothing to propose from. (The old `candidates.length <= 1`
  // early return is deliberately gone: with the full canonical list there is always
  // something to decide, and that guard — plus its caller-side twin — is exactly what
  // made the classifier a no-op for 60% of the library.)
  if (resources.length === 0 || candidates.length === 0) return map;

  // The fallback is trusted even when it is outside the vocabulary — it is the caller's
  // own request topic, not something the model invented, and a topic can legitimately be
  // un-canonicalized (measured 2026-07-25: a `rust` discovery run, where none of the 20
  // canonicals fit). Without this, an explicit "none of these fit" verdict is
  // indistinguishable from the model failing, and the guardrail logs `no-evidence` for
  // what was actually a deliberate answer.
  const allowed = new Set([...candidates, fallback]);
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
        'Candidate topics (use these slugs exactly):',
        JSON.stringify(candidates),
        `If a resource does not clearly fit any candidate, return "${fallback}" alone.`,
        '',
        'Resources to file:',
        JSON.stringify(input, null, 2),
      ].join('\n'),
    });

    for (const r of result.object.results) {
      const topics = [...new Set(r.topics)].filter((t) => allowed.has(t)).slice(0, MAX_PROPOSALS);
      // A `newTopic` that is already in the vocabulary is not a mint — the model just
      // answered in the wrong field; drop it rather than sending the gate on a round-trip
      // to rediscover a slug we already have.
      const raw = r.newTopic?.trim();
      const newTopic = raw && !allowed.has(raw) ? raw : null;
      if (topics.length > 0 || newTopic) map.set(r.url, { topics, newTopic });
    }
  } catch (err) {
    console.warn('[classify-topic] classification failed, filing under request topic', {
      count: resources.length,
      vocabulary: candidates.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return map;
}

const CLASSIFY_SYSTEM_PROMPT = `You file a freshly discovered learning resource under the topic slugs it belongs to, chosen from a fixed list of candidates.

Rules:
- Return one entry per input resource, keyed by its url, with "topics" ranked most-confident first.
- Return ONE topic unless the resource genuinely teaches more than one subject well enough that a learner of the second subject would want it. Two or three topics are for a resource that squarely belongs on several shelves, not for hedging between guesses.
- Every slug must appear in the candidate list exactly. Never invent a slug, and never return a topic you are merely unsure about — omit it instead.
- Choose the most SPECIFIC candidate the resource squarely belongs to. A specialization slug (e.g. "javascript-react") is for resources that actually teach or require that specialization; a foundational slug (e.g. "javascript") is for resources covering only the general subject.
- When a resource covers only the foundational subject and does NOT require the specialization, choose the foundational topic — even though it was discovered while building the specialization's library.
- The topic a resource was DISCOVERED under carries no weight. File it where it belongs, not where it was found.
- Be conservative: when genuinely unsure, return the fallback topic given in the prompt rather than guessing.
- "newTopic": null on almost every resource. Set it ONLY when the resource's actual subject is missing from the candidate list entirely — not when a candidate is merely a loose fit — and then give one new kebab-case slug naming that subject at the same level of generality as the candidates (e.g. "algebra", not "solving-quadratic-equations" and not "math"). It must be a legitimate mathematics, natural-science or computer-science topic. Still fill "topics" with your best available choice; "newTopic" is a proposal reviewed separately, not a replacement.`;
