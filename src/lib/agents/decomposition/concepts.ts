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
import type { ConceptOrigin } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/ai/models';
import { logWarn } from '@/lib/log';
import { describeError } from '@/lib/ai/describe-error';
import {
  CONCEPT_DERIVATION_CHUNK_SIZE,
  CONCEPT_DERIVATION_BISECT_BUDGET_MULTIPLIER,
} from '@/lib/config';

// The distinct concept tags already in use by a topic — the vocabulary new tags
// are grounded against. Includes pending_review rows so freshly-found resources
// contribute their tags before promotion.
//
// Only `derived` rows count. Grounding on an inherited array would tell the next
// derivation to reuse the tags a *failed* derivation left behind — the feedback
// loop that spread one bad batch across a topic's whole vocabulary (P1).
export async function loadTopicVocab(topic: string): Promise<string[]> {
  const rows = await prisma.resource.findMany({
    where: { topic, status: { in: ['active', 'pending_review'] }, conceptOrigin: 'derived' },
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

// What every ChildInput-producing router writes for one child. The origin is the
// point: a child that inherited its parent's array must never be storable as if
// it had been derived, because that is exactly what made P1 invisible.
export type ResolvedConcepts = DerivedConcepts & { conceptOrigin: ConceptOrigin };

// Single decision point for all four inheritance sites (the three routers' leaf
// paths plus doc-TOC's sub-container path, which never attempts derivation and
// so always passes `undefined`).
export function resolveConcepts(args: {
  derived: DerivedConcepts | undefined;
  parentConcepts: string[];
  topic: string;
}): ResolvedConcepts {
  const { derived, parentConcepts, topic } = args;
  if (derived) {
    return {
      prerequisiteConcepts: derived.prerequisiteConcepts,
      conceptsTaught: derived.conceptsTaught,
      conceptOrigin: 'derived',
    };
  }
  // Never leave a child with no conceptsTaught — cross-resource dedup keys on it.
  if (parentConcepts.length > 0) {
    return { prerequisiteConcepts: [], conceptsTaught: parentConcepts, conceptOrigin: 'inherited' };
  }
  return { prerequisiteConcepts: [], conceptsTaught: [topic], conceptOrigin: 'fallback' };
}

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

  // Batches are independent, so derive them in parallel — on the live discovery
  // path a container decomposes synchronously, and the oversize gate caps it at
  // DECOMPOSITION_MAX_AUTO_CHILDREN, so this fans out to at most a couple of
  // concurrent calls (no rate-limit concern) while halving latency for >1-batch
  // containers. Refs a batch never recovers stay unmapped; the caller resolves
  // them to an `inherited`/`fallback` array via resolveConcepts.
  const batches = chunk(items, CONCEPT_DERIVATION_CHUNK_SIZE);
  const batchResults = await Promise.all(
    batches.map((batch) =>
      deriveWithBisect(batch, (b) => callDeriver(topic, grounding, b), { topic }),
    ),
  );
  for (const result of batchResults) {
    for (const [ref, concepts] of result) out.set(ref, concepts);
  }

  // Unmapped refs are not an error — the caller resolves them to inherited/fallback
  // concepts. But they used to be invisible in aggregate: the per-node warnings say
  // a batch failed, never how much of the container ended up underived. This is the
  // line that says whether a decomposition's tags are mostly derived or mostly
  // inherited, and the one that surfaces a budget that ran out.
  if (out.size < items.length) {
    logWarn('concepts.derive_incomplete', {
      topic,
      requested: items.length,
      derived: out.size,
      batches: batches.length,
    });
  }

  return out;
}

// Retry once, then bisect. A whole batch failing is usually ONE malformed item
// poisoning the structured-output parse for all 25, so halving isolates the
// poison and recovers the other 24 instead of writing off the batch. Recursion
// bottoms out at a single item, which is either derived or genuinely undeducible
// — and that one loss is now logged and stamped rather than silent.
//
// The bounded-worst-case claim this comment used to make was wrong in the way
// that matters: 2 attempts over a 2n-1-node tree IS bounded, but at ~98 calls for
// a 25-item batch, which is a bound in name only. It assumed a real batch fails at
// one or two leaves. On 2026-08-30 a multivariable-calculus build met the case
// where the model failed the schema for EVERY subset: the tree collapsed all the
// way down (25 -> 13/12 -> 7/6 -> 3/3 -> 1) and burned 14 minutes of a 30-minute
// job deadline. So the recursion now shares a call budget, and a spent budget
// abandons the remaining items instead of splitting further — bisection is a
// recovery heuristic, and once its one-poison-item premise is visibly false,
// continuing to split buys nothing.
//
// `run` and `budget` are injected so the bisection is testable without the model.
//
// Exported for the same reason: the budget floor is a property of the recursion's
// shape, so a test asserts it against the real cost rather than a copied number.
export function bisectBudgetFor(batchSize: number): number {
  const singlePoisonCost = 3 * Math.ceil(Math.log2(Math.max(batchSize, 2))) + 2;
  return CONCEPT_DERIVATION_BISECT_BUDGET_MULTIPLIER * singlePoisonCost;
}

export async function deriveWithBisect(
  batch: DerivableItem[],
  run: (b: DerivableItem[]) => Promise<Map<string, DerivedConcepts>>,
  ctx: { topic: string },
  budget: { remaining: number } = { remaining: bisectBudgetFor(batch.length) },
): Promise<Map<string, DerivedConcepts>> {
  if (batch.length === 0) return new Map();

  let lastError: ReturnType<typeof describeError> = { error: '' };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Checked per ATTEMPT, not per node: the retry is the other half of the cost,
    // and a budget that only gates recursion would still pay 2 calls at each of
    // the nodes it was meant to stop creating.
    if (budget.remaining <= 0) return new Map();
    budget.remaining -= 1;
    try {
      return await run(batch);
    } catch (err) {
      // finishReason/schemaIssues are what separate "the response was truncated"
      // from "the schema rejected it" — the two have opposite fixes, and
      // err.message alone reads identically for both.
      lastError = describeError(err);
      logWarn('concepts.derive_batch_failed', {
        topic: ctx.topic,
        batchSize: batch.length,
        attempt,
        ...lastError,
      });
    }
  }

  if (batch.length === 1) {
    logWarn('concepts.derive_item_abandoned', {
      topic: ctx.topic,
      ref: batch[0].ref,
      ...lastError,
    });
    return new Map();
  }

  const mid = Math.ceil(batch.length / 2);
  // Sequential, not Promise.all: the halves share one budget, and running them
  // concurrently lets both read the same `remaining` before either decrements —
  // so a spent budget would still fund a full extra level of the tree.
  const halves = [
    await deriveWithBisect(batch.slice(0, mid), run, ctx, budget),
    await deriveWithBisect(batch.slice(mid), run, ctx, budget),
  ];
  const out = new Map<string, DerivedConcepts>();
  for (const half of halves) {
    for (const [ref, concepts] of half) out.set(ref, concepts);
  }
  return out;
}

// One model call. Throws on failure — deriveWithBisect owns the recovery policy.
async function callDeriver(
  topic: string,
  grounding: string[],
  batch: DerivableItem[],
): Promise<Map<string, DerivedConcepts>> {
  const out = new Map<string, DerivedConcepts>();
  const { model, temperature, maxOutputTokens } = getModel('conceptDeriver');
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
    out.set(r.ref, { prerequisiteConcepts: r.prerequisiteConcepts, conceptsTaught: r.conceptsTaught });
  }
  return out;
}
