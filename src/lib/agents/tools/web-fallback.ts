// Targeted per-concept sourcing — the two rungs of the ladder that live here.
//
//   libraryRungCandidates({ topic, conceptTitle }) — rung 0: EXISTING library rows
//     semantically near the concept. No discovery, no validation, no writes.
//   sourceFromWeb({ topic, concept, targetCount }) — rungs 1-2: allowlisted
//     fan-out, then open-web relaxation. Returns insertedIds so the caller can
//     attach them by id without waiting on the post-commit embed.
//
// The two are deliberately SEPARATE entry points (rung0-starvation R1). The caller
// — source-concept.ts — judges rung 0 first and derives the web budget from what
// SURVIVED the judge, so a shelf of near-but-wrong neighbours can no longer zero
// the web budget with raw search hits. The judge can't live here: source-concept.ts
// imports this module, so calling it from here would cycle.
//
// This was once a two-entry-point module in a different sense — the topic-level
// scattershot `runWebFallback` (the old generate-path library-floor fallback) shared
// this same discover → validate → maybe re-discover engine + decompose →
// canonicalize → file → upsert tail. That entry retired in the Phase 2.5g cutover:
// under the concept-map/Track architecture, library growth is driven by TARGETED
// per-concept sourcing, not coarse per-topic dumps. The shared engine
// (collectSurvivors / persistDiscovered / runDiscovery) stays — sourceFromWeb is
// now its only caller.
//
// Locked by ROADMAP: grounded search via Vertex's googleSearch tool, NOT an
// agent-with-tools loop. The "loop" here is in the application layer
// (discover → validate → maybe re-discover), not handed to the model.

import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import type { Difficulty } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/ai/models';
import { recordUsage } from '@/lib/log';
import { vertex } from '@/lib/ai/vertex';
import {
  REMEDIATION_SOURCE_TARGET_COUNT,
  REMEDIATION_DISCOVERY_OVERSAMPLE,
  REMEDIATION_MAX_DISCOVERY_ITERATIONS,
  REJUDGE_ROUTE_MAX_DISTANCE,
} from '@/lib/config';
import { searchNearbyResources } from '@/lib/agents/tools/search-resources';
import { runValidationPipeline } from '@/lib/agents/validation';
import { livenessValidator } from '@/lib/agents/validation/validators/liveness';
import { rulesAgentValidator } from '@/lib/agents/validation/validators/rules-agent';
import { decompose } from '@/lib/agents/decomposition/decompose';
import { crediblePageTitle } from '@/lib/agents/decomposition/page-title';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { loadTopicVocab } from '@/lib/agents/decomposition/concepts';
import { classifyDiscoveryTopics } from '@/lib/agents/tools/classify-topic';
import { searchYouTubeForConcept, type YoutubeSourcedResource } from '@/lib/agents/tools/youtube-search';
import { deriveSourcedForPairs, type SourcedForRow } from '@/lib/agents/tools/sourced-for';
import { safeEmbedBatch } from '@/lib/ai/embeddings';
import { listCanonicals } from '@/lib/agents/topic-registry';
import { decideFiling, decideMintedFiling, knnNeighbourTopics, topicPools } from '@/lib/curation/topic-knn';
import { createTopicMinter } from '@/lib/curation/topic-mint';
import { relatedTopics } from '@/types/resource';

const RAW_RESOURCE_TYPES = ['article', 'video', 'course', 'interactive', 'docs', 'book'] as const;
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;

const DiscoveredResourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(3),
  type: z.enum(RAW_RESOURCE_TYPES),
  difficulty: z.enum(DIFFICULTIES),
  durationMin: z.number().int().min(1).max(6000),
  summary: z.string().min(10),
  rawPrerequisiteConcepts: z.array(z.string()).default([]),
  rawConceptsTaught: z.array(z.string()).min(1),
});

type DiscoveredResource = z.infer<typeof DiscoveredResourceSchema>;

// A discovered row enriched with sourcing provenance. Grounded prongs produce
// plain DiscoveredResource rows that still need validation; the YouTube prong
// produces rows that are already live + stat-gated (`preValidated`) and carry the
// engagement metadata (`youtube`) that upsertResource folds into trustScore.
type SourcedResource = DiscoveredResource & {
  youtube?: { channelId: string; viewCount: number; likeCount: number | null };
  preValidated?: boolean;
};

// Adapt a YouTube-prong row into the common SourcedResource shape (the prong
// already derived final concept tags; map them onto the raw* fields the
// persistence tail expects, and mark it pre-validated to skip the URL validators).
function youtubeToSourced(r: YoutubeSourcedResource): SourcedResource {
  return {
    url: r.url,
    title: r.title,
    type: r.type,
    difficulty: r.difficulty,
    durationMin: r.durationMin,
    summary: r.summary,
    rawPrerequisiteConcepts: r.prerequisiteConcepts,
    rawConceptsTaught: r.conceptsTaught,
    youtube: r.youtube,
    preValidated: true,
  };
}

const CanonicalizedTagsSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().url(),
        prerequisiteConcepts: z.array(z.string()),
        conceptsTaught: z.array(z.string()).min(1),
      }),
    )
    .min(0),
});

// What the web half of a sourcing run persisted (unchanged semantics — these
// trace/report fields describe DISCOVERY, not the library rung).
export type WebFallbackResult = {
  insertedCount: number;
  skippedCount: number;
  discoveredCount: number;
  iterations: number;
  // Newly-created atomic (pickable) resource ids from this run. The remediation
  // re-judge (source-concept.ts) loads them by id to attach as candidates before
  // the post-commit embed lands.
  insertedIds: string[];
};

// One rung-0 hit: the resource id plus its cosine distance to the concept query.
// searchNearbyResources always ranks, so the distance is never null here.
export type LibraryCandidate = { id: string; distance: number };

const VALIDATORS = [livenessValidator, rulesAgentValidator];

// Phase 2.5f: source resources that TEACH one specific concept, for spine-hole
// remediation and the in-track thickener. Same engine + persistence tail as the
// topic fallback, but a concept-focused discovery prompt and a tighter budget.
// Returns insertedIds so the re-judge can attach via searchResources({ includeIds })
// before the post-commit embed lands. `targetMastery` (set by the in-track
// thickener, omitted by mastery-agnostic spine-hole remediation) biases discovery
// toward that learner level.
//
// `targetCount` is the WEB BUDGET the caller derived from rung 0's judged
// survivors (webShortfall) — not the concept's total target. This function is
// only called when that budget is > 0.
export async function sourceFromWeb({
  topic,
  concept,
  conceptId,
  targetCount = REMEDIATION_SOURCE_TARGET_COUNT,
  targetMastery,
  preferSubstantial = false,
  abortSignal,
}: {
  topic: string;
  concept: { slug: string; title: string };
  // Library re-judge Block 1: the demanding Concept's id, recorded as
  // ResourceSourcedFor provenance for rows that park non-atomic (so the
  // decompose-time hook can later route their children back to this concept's
  // path). Optional — a caller without a Concept row writes no provenance.
  conceptId?: string;
  targetCount?: number;
  targetMastery?: Difficulty;
  // Budget-fill Block 2: bias every prong toward substantial (~20-90m) resources.
  // Set for budget-thin concepts (thinForBudget) - the library is mostly <=30m
  // clips, and another clip can't fill a deep-tier core. Prompt-level steer for
  // the grounded prongs; videoDuration=long for the YouTube prong. The Block 0
  // attach ceiling still drops whole-course monsters this surfaces.
  preferSubstantial?: boolean;
  // Audit 2.2: the worker's per-job abort (deadline/shutdown), threaded into the
  // discovery AI calls + googleapis fetches and checked between iterations, so an
  // aborted job stops mid-ladder instead of finishing minutes of grounded
  // discovery + persistence it no longer owns.
  abortSignal?: AbortSignal;
}): Promise<WebFallbackResult> {
  const label = `${topic}::${concept.slug}`;
  abortSignal?.throwIfAborted();
  // The web half of the sourcing LADDER (replaces the old "same vague open-web
  // query, repeated"):
  //   rung 0 — the EXISTING library (libraryRungCandidates, below). Cheapest by
  //     far: no discovery, no validation, no upsert. The COST POLICY it buys is
  //     unchanged and still locked — where the library genuinely covers a concept,
  //     the web rungs are skipped entirely and this function is never called. What
  //     changed in R1 is the arithmetic behind that skip: the caller judges rung 0
  //     first and spends the budget on judged SURVIVORS, so raw hits that the judge
  //     throws away no longer suppress discovery (they used to, permanently — see
  //     docs/rung0-starvation-plan.md).
  //   rung 1 (iteration 1) — allowlisted fan-out: the YouTube Data API prong +
  //     a grounded prong hard-restricted to the curated source domains. Distinct
  //     queries against high-quality sources, so a concept usually fills here.
  //   rung 2 (iteration 2+) — open-web relaxation: today's broad grounded prompt,
  //     run only when rung 1 came up short (protects coverage on thin/niche concepts).
  // collectSurvivors carries the deny-list across rungs so a rung never re-surfaces
  // what an earlier rung already returned.
  const allowDomains = await loadAllowlistDomains();
  const { survivors, iterations, totalDiscovered } = await collectSurvivors({
    label,
    targetCount,
    oversample: REMEDIATION_DISCOVERY_OVERSAMPLE,
    maxIterations: REMEDIATION_MAX_DISCOVERY_ITERATIONS,
    discover: (oversample, denyList, iteration) =>
      iteration === 1
        ? discoverAllowlisted(topic, concept.title, oversample, denyList, allowDomains, targetMastery, preferSubstantial, abortSignal)
        : discoverForConcept(topic, concept.title, oversample, denyList, targetMastery, preferSubstantial, abortSignal),
    abortSignal,
  });
  const persisted = await persistDiscovered(topic, survivors, {
    label,
    iterations,
    totalDiscovered,
    targetCount,
    sourcedForConceptId: conceptId ?? null,
    abortSignal,
  });
  return persisted;
}

// How many resources web discovery still owes after the library rung. `libraryAttached`
// is the count of rung-0 candidates that SURVIVED the judge and attached — not the raw
// search hits (R1: raw hits used to be counted here, so three near-but-wrong neighbours
// zeroed the budget forever). Floored at 0 so an over-full library rung can't demand
// negative discovery.
export function webShortfall(targetCount: number, libraryAttached: number): number {
  return Math.max(0, targetCount - libraryAttached);
}

// Rung 0: existing library rows near the concept. Scoped like the cold map
// build's candidate search (topic ∪ related topics, excludeGenerated, the
// default active+pending_review window via searchNearbyResources), gated by the
// same distance ceiling the decompose-time hook routes with — a hit must be
// semantically close, not merely high-trust. Two classes of row are excluded,
// both because re-judging them is pure spend: those already ATTACHED to the
// demanding concept (judged when they attached), and — rung0-starvation R2 —
// those already JUDGED AND REJECTED for it. The second is what makes the R1 fix
// durable: without it every later remediation re-buys the same verdict on the
// same near-but-wrong neighbours before it can earn a web budget.
//
// Returns CANDIDATES, not survivors. The caller judges them and only then derives
// the web budget (source-concept.ts) — this function's output must never be used
// as a coverage measure on its own.
//
// Returns the ranked search rows, not bare ids: rung 0 IS a ranked search, and the
// distance is the signal the rung-0 coverage diagnostic reports per hit
// (scripts/rung0-coverage.ts — a hole saturated at d=0.25 by well-filed rows is a
// different story from one saturated at d=0.45 by relevance-0.00 junk). The
// sourcing caller discards them (`.map(h => h.id)`); that is its choice to make.
export async function libraryRungCandidates(args: {
  topic: string;
  conceptTitle: string;
  conceptId?: string;
  targetCount: number;
}): Promise<LibraryCandidate[]> {
  const { topic, conceptTitle, conceptId, targetCount } = args;
  // Both exclusions are keyed by concept, so a caller without a Concept row
  // (there is no id to look either up by) simply gets the unfiltered rung.
  const [attached, rejected] = conceptId
    ? await Promise.all([
        prisma.conceptResource.findMany({ where: { conceptId }, select: { resourceId: true } }),
        prisma.conceptCandidateRejection.findMany({ where: { conceptId }, select: { resourceId: true } }),
      ])
    : [[], []];
  return searchNearbyResources({
    topics: relatedTopics(topic),
    query: conceptTitle,
    maxDistance: REJUDGE_ROUTE_MAX_DISTANCE,
    limit: targetCount,
    excludeIds: [...attached, ...rejected].map((r) => r.resourceId),
  });
}

// ── shared engine ─────────────────────────────────────────────────────────────

// The discover → validate → dedupe → collect loop, parameterized by a discover
// callback so the topic-level and per-concept entry points share it. Returns the
// surviving rows (deduped by url) plus run stats.
async function collectSurvivors(args: {
  label: string;
  targetCount: number;
  oversample: number;
  maxIterations: number;
  // `iteration` is 1-based so the ladder can pick a rung (1 = allowlisted, 2+ =
  // open-web relaxation). The deny-list carries across rungs.
  discover: (oversample: number, denyList: string[], iteration: number) => Promise<SourcedResource[]>;
  abortSignal?: AbortSignal;
}): Promise<{ survivors: SourcedResource[]; iterations: number; totalDiscovered: number }> {
  const { label, targetCount, oversample, maxIterations, discover, abortSignal } = args;
  const survivors = new Map<string, SourcedResource>();
  const denyList = new Set<string>();
  let iterations = 0;
  let totalDiscovered = 0;

  while (survivors.size < targetCount && iterations < maxIterations) {
    abortSignal?.throwIfAborted();
    iterations += 1;
    const need = targetCount - survivors.size;

    const discovered = await discover(oversample, [...denyList], iterations);
    totalDiscovered += discovered.length;

    // Always block URLs we've already seen this run from re-discovery, even
    // if validation drops them — no point spending tokens twice.
    for (const r of discovered) denyList.add(r.url);

    // Skip rows already-known-good in this loop (model could re-surface them
    // in iteration 2+ if Google Search returns them).
    const fresh = discovered.filter((r) => !survivors.has(r.url));
    if (fresh.length === 0) {
      // scripts/verify-rung0-fix.ts pattern-matches this message + `iteration` field
      // (its rung tracking, including migration off console.log) — change in lockstep.
      console.log('[web-fallback] iteration produced no fresh URLs', { label, iteration: iterations });
      continue;
    }

    // The YouTube prong's rows are already live (API) + view-floor-gated, so they
    // skip the URL validators (liveness/rules-agent); only the grounded-prong rows
    // run the pipeline.
    const preValidated = fresh.filter((r) => r.preValidated);
    const needValidation = fresh.filter((r) => !r.preValidated);
    const { valid, rejected } = await runValidationPipeline<SourcedResource>(needValidation, VALIDATORS);

    for (const r of rejected) {
      console.log('[web-fallback] rejected', { url: r.row.url, validator: r.validator, reason: r.reason });
    }

    // Interleave the prongs rather than taking all YouTube first, so when one prong
    // alone could fill the target it doesn't starve the other — a concept's library
    // entries stay a MIX of video + allowlisted docs/courseware/textbook, giving the
    // downstream judge/composer a real choice of format.
    for (const r of interleave(preValidated, valid)) {
      if (survivors.size >= targetCount) break;
      survivors.set(r.url, r);
    }

    // scripts/verify-rung0-fix.ts pattern-matches this message + `rung` field (its
    // rung tracking, including migration off console.log) — change in lockstep.
    console.log('[web-fallback] iteration', {
      label,
      iteration: iterations,
      rung: iterations === 1 ? 'allowlisted' : 'open-web',
      discovered: discovered.length,
      fresh: fresh.length,
      preValidated: preValidated.length,
      valid: valid.length,
      survivors: survivors.size,
      need,
    });
  }

  return { survivors: [...survivors.values()], iterations, totalDiscovered };
}

// Round-robin merge of two prongs' rows, so neither is systematically crowded out
// when the target fills before both are exhausted. Order within each list is kept.
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// The persistence tail shared by both entry points: decompose → canonicalize →
// file under home topic → upsert. `topic` is the request topic (the filing anchor);
// survivors are filed under topic ∪ related per the classifier.
async function persistDiscovered(
  topic: string,
  finalRows: SourcedResource[],
  meta: {
    label: string;
    iterations: number;
    totalDiscovered: number;
    targetCount: number;
    // Non-null when a Concept's demand drove this run — provenance pairs are
    // written for rows that park non-atomic (see recordSourcedFor below).
    sourcedForConceptId: string | null;
    abortSignal?: AbortSignal;
  },
): Promise<WebFallbackResult> {
  const { label, iterations, totalDiscovered, targetCount, sourcedForConceptId, abortSignal } = meta;
  // Audit 2.2: an aborted job must not start the decompose/canonicalize/upsert
  // tail — that's both LLM spend and zombie WRITES racing a successor build.
  abortSignal?.throwIfAborted();
  if (finalRows.length === 0) {
    console.log('[web-fallback] no survivors', { label, iterations, totalDiscovered });
    return { insertedCount: 0, skippedCount: 0, discoveredCount: totalDiscovered, iterations, insertedIds: [] };
  }

  // Decompose each survivor before persisting (ROADMAP 2.5b decision #6:
  // discover → validate → decompose → upsert). Atomic stays atomic; a YouTube
  // playlist is exploded into atomic children here; other containers park as
  // pending/human_review until their router ships.
  const decomposed = await Promise.all(
    finalRows.map(async (row) => ({
      row,
      result: await decompose({
        url: row.url,
        title: row.title,
        type: row.type,
        topic,
        difficulty: row.difficulty,
        summary: row.summary,
        conceptsTaught: row.rawConceptsTaught,
        durationMin: row.durationMin,
      }),
    })),
  );

  // The title each row is actually persisted with. Discovery's `title` is free text
  // the model wrote about what it went LOOKING for — where a router fetched the page,
  // the page's own <title> is the only statement of what the URL really is, and a
  // container titled after the sub-topic that demanded it mis-files, mis-embeds and
  // mis-routes (see page-title.ts). Resolved HERE, before classification and the
  // embed below, so the correction reaches the filing evidence and the vector rather
  // than just the stored string.
  const titleByUrl = new Map(
    decomposed.map(({ row, result }) => [
      row.url,
      crediblePageTitle(result.pageTitle, row.title, row.url) ?? row.title,
    ]),
  );
  for (const { row } of decomposed) {
    const corrected = titleByUrl.get(row.url)!;
    if (corrected !== row.title) {
      console.log('[web-fallback] title corrected from page', {
        url: row.url,
        discovered: row.title,
        page: corrected,
      });
    }
  }

  // Canonicalize concepts only for atomic survivors. Container parents are
  // unpickable, so their own concepts don't drive selection or dedup — per
  // decision A, canonicalization for a container's children happens inside the
  // router (concepts.ts), not here.
  const atomicRows = decomposed
    .filter((d) => d.result.status === 'atomic')
    .map((d) => d.row);
  abortSignal?.throwIfAborted();
  const vocab = await loadTopicVocab(topic);
  const canonical = await canonicalizeTags(atomicRows, vocab, abortSignal);

  // File each survivor under its home topic rather than blindly stamping the request
  // topic. Topic filing T2b: the vocabulary is now every canonical, not
  // relatedTopics(topic) — and the caller-side skip that made this a no-op for topics
  // with no edges (60% of the library) is gone with it. The classifier only PROPOSES;
  // decideFiling tests each proposal against the resource's embedding neighbourhood
  // below. Decomposed children inherit the parent's filing via createChild.
  // T3: the classifier may also name a subject the vocabulary LACKS (`newTopic`), which
  // the topic gate turns into a canonical below. That is the only way a discovery can
  // widen the vocabulary — pre-T3 a new canonical could only be born from a learner
  // request, so a resource whose real subject we had no slug for was unfilable forever.
  const vocabulary = await listCanonicals();
  const proposalsByUrl = await classifyDiscoveryTopics(
    finalRows.map((r) => ({
      url: r.url,
      title: titleByUrl.get(r.url) ?? r.title,
      summary: r.summary,
      conceptsTaught: r.rawConceptsTaught,
    })),
    vocabulary,
    topic,
  );

  // The tags each row is actually persisted with: canonicalized for atomic survivors,
  // raw for containers (canonicalizeTags only covers the atomic set). Hoisted out of the
  // upsert loop because the embedding below must be built from the SAME text the row
  // carries — embed the raw tags and the vector wouldn't match what a re-embed produces.
  const tagsByUrl = new Map(
    decomposed.map(({ row }) => [
      row.url,
      canonical.get(row.url) ?? {
        prerequisiteConcepts: row.rawPrerequisiteConcepts,
        conceptsTaught: row.rawConceptsTaught,
      },
    ]),
  );

  // Topic filing T2a: embed the batch BEFORE inserting anything, so the row is written
  // already embedded and the T2b filing guardrail has its input at filing time — embeds
  // used to run post-commit, which would leave every fresh find on the "no embedding
  // yet" degradation path at the guardrail's primary application point. One batched
  // call; best-effort, so a failure just returns nulls and the post-commit embed in
  // upsertResource still covers the atomic rows.
  abortSignal?.throwIfAborted();
  const embeddings = await safeEmbedBatch(
    decomposed.map(({ row }) => ({
      title: titleByUrl.get(row.url)!,
      summary: row.summary,
      conceptsTaught: tagsByUrl.get(row.url)!.conceptsTaught,
    })),
  );

  // Guardrail evidence, gathered for the WHOLE BATCH BEFORE the first insert. Doing this
  // inside the upsert loop instead would make filing order-dependent: each inserted row
  // joins the library and becomes a neighbour for the rows after it, so a batch could
  // bootstrap its own evidence (measured 2026-07-25 on a cold `rust` run — the request
  // topic's purity climbed 0.0 → 0.1 → 0.2 across three inserts of the same batch).
  // A snapshot makes the batch's decisions independent of each other and of their order.
  const pools = await topicPools();
  const neighbourhoods = await Promise.all(
    embeddings.map((vector) => (vector ? knnNeighbourTopics(vector) : Promise.resolve([]))),
  );

  // One minter for the whole batch: several rows commonly propose the same missing
  // subject, and the gate's tier 3 is an LLM call.
  const mintTopic = createTopicMinter();

  let insertedCount = 0;
  let skippedCount = 0;
  let membershipAddedCount = 0;
  let reclassifiedCount = 0;
  let contestedCount = 0;
  let mintedCount = 0;
  const insertedIds: string[] = [];
  const upsertedRows: SourcedForRow[] = [];
  for (const [i, { row, result }] of decomposed.entries()) {
    const tags = tagsByUrl.get(row.url)!;
    // The guardrail: a proposal only becomes a membership if the resource's embedding
    // actually sits among that topic's resources. No embedding (the batch embed failed)
    // means no evidence — decideFiling degrades to the request topic on an empty
    // neighbour list, which is the pre-T2b behaviour.
    const vector = embeddings[i];
    const proposal = proposalsByUrl.get(row.url);
    const evidence = {
      proposals: proposal?.topics ?? [],
      requestTopic: topic,
      neighbourTopics: neighbourhoods[i],
      pools,
    };
    let filing = decideFiling(evidence);
    // T3 minting: only when NO existing canonical cleared the guardrail. An accepted
    // proposal is evidence about a topic we already have, and evidence beats a mint —
    // otherwise a model that volunteers `newTopic` too eagerly could fragment a healthy
    // shelf. The gate may still resolve the label onto an existing canonical (tier 1/2,
    // or T1.5's snap), in which case this is a lookup, not a mint.
    if ((filing.reason === 'rejected' || filing.reason === 'no-evidence') && proposal?.newTopic) {
      const minted = await mintTopic(proposal.newTopic);
      if (minted) {
        filing = decideMintedFiling(evidence, minted);
        mintedCount += 1;
      }
    }
    const filedTopic = filing.primary.topic;
    if (filedTopic !== topic) reclassifiedCount += 1;
    if (filing.primary.contested) contestedCount += 1;
    const { outcome, atomicIds, resourceId, decompositionStatus } = await upsertResource(
      filedTopic,
      {
        url: row.url,
        title: titleByUrl.get(row.url)!,
        type: row.type,
        difficulty: row.difficulty,
        durationMin: row.durationMin,
        summary: row.summary,
        prerequisiteConcepts: tags.prerequisiteConcepts,
        conceptsTaught: tags.conceptsTaught,
        // Present only for YouTube-prong rows — drives channel source resolution +
        // engagement trust in upsertResource.
        youtube: row.youtube,
      },
      result,
      vector,
      filing,
    );
    console.log('[web-fallback] filed', {
      url: row.url,
      requestTopic: topic,
      filedTopic,
      reason: filing.reason,
      relevance: Number(filing.primary.relevance.toFixed(2)),
      contested: filing.primary.contested,
      secondaries: filing.secondaries.map((s) => s.topic),
    });
    // T3: a dedup hit that cleared the collision guardrail is neither an insert nor a
    // skip — nothing was written to "Resource", but the requested topic can now retrieve
    // a row it previously could not reach at all.
    if (outcome === 'inserted') insertedCount += 1;
    else if (outcome === 'membership_added') membershipAddedCount += 1;
    else skippedCount += 1;
    insertedIds.push(...atomicIds);
    upsertedRows.push({ resourceId, decompositionStatus });
  }

  // Library re-judge Block 1: record sourcing provenance for rows that parked
  // non-atomic — this run demanded them but can't attach them, so the
  // decompose-time hook needs to know which concept asked. Covers both fresh
  // inserts and dedup rediscoveries of an existing parked row (a second demand
  // under a new concept is a second pair; same concept is skipDuplicates'd).
  // Best-effort: provenance is a side channel — a write failure (e.g. the
  // concept was deleted mid-run) must not fail the sourcing run itself.
  const sourcedForPairs = deriveSourcedForPairs(sourcedForConceptId, upsertedRows);
  if (sourcedForPairs.length > 0) {
    try {
      await prisma.resourceSourcedFor.createMany({ data: sourcedForPairs, skipDuplicates: true });
    } catch (err) {
      console.warn('[web-fallback] sourced-for provenance write failed', {
        label,
        pairs: sourcedForPairs.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log('[web-fallback] summary', {
    label,
    iterations,
    discoveredCount: totalDiscovered,
    survivors: finalRows.length,
    insertedCount,
    skippedCount,
    membershipAddedCount,
    reclassifiedCount,
    contestedCount,
    mintedCount,
    sourcedForPairs: sourcedForPairs.length,
    targetMet: finalRows.length >= targetCount,
  });
  return { insertedCount, skippedCount, discoveredCount: totalDiscovered, iterations, insertedIds };
}

// ── discovery: rung 1 (allowlisted fan-out) ───────────────────────────────────

// Phase 2.5h rung 1: source from the CURATED set only — the YouTube Data API prong
// (videos, channel-trusted + view-gated) plus a grounded prong hard-restricted to
// the allowlisted documentation/courseware/textbook/educator domains. Both queries
// run in parallel and merge; the grounded results are domain-filtered so nothing
// off-allowlist slips in at this rung. Failures in either prong degrade to empty —
// the ladder's rung 2 (open web) is the relaxation.
async function discoverAllowlisted(
  topic: string,
  conceptTitle: string,
  oversample: number,
  denyList: string[],
  allowDomains: string[],
  targetMastery?: Difficulty,
  preferSubstantial = false,
  abortSignal?: AbortSignal,
): Promise<SourcedResource[]> {
  const [ytRows, groundedRows] = await Promise.all([
    searchYouTubeForConcept({ topic, conceptTitle, maxResults: oversample, difficulty: targetMastery, denyUrls: denyList, preferSubstantial, abortSignal })
      .catch((err) => {
        // Degrade-to-empty must not swallow the job abort — the grounded prong's
        // own abort throw still fails the Promise.all, so nothing is lost, but
        // rethrowing keeps the failure attributed to the abort, not the prong.
        if (abortSignal?.aborted) throw err;
        console.warn('[web-fallback] youtube prong failed', { conceptTitle, error: err instanceof Error ? err.message : String(err) });
        return [] as YoutubeSourcedResource[];
      }),
    discoverForConceptScoped(topic, conceptTitle, oversample, denyList, allowDomains, targetMastery, preferSubstantial, abortSignal),
  ]);
  return [...ytRows.map(youtubeToSourced), ...groundedRows];
}

// The grounded prong restricted to allowlisted domains. Same engine as the open-web
// prong but the prompt names the allowed domains and instructs site-scoped search,
// and a hard post-filter drops any URL whose host isn't on the allowlist (the model
// strays; the filter is the guarantee, not the prompt).
async function discoverForConceptScoped(
  topic: string,
  conceptTitle: string,
  oversample: number,
  denyList: string[],
  allowDomains: string[],
  targetMastery?: Difficulty,
  preferSubstantial = false,
  abortSignal?: AbortSignal,
): Promise<SourcedResource[]> {
  if (allowDomains.length === 0) return [];
  const rows = await runDiscovery({
    label: `${topic}::${conceptTitle} (allowlisted)`,
    oversample,
    denyListSize: denyList.length,
    system: CONCEPT_DISCOVERY_SYSTEM_PROMPT,
    prompt: buildScopedConceptDiscoveryPrompt(topic, conceptTitle, oversample, denyList, allowDomains, targetMastery, preferSubstantial),
    abortSignal,
  });
  const allow = new Set(allowDomains);
  const onAllowlist = rows.filter((r) => {
    const host = hostnameOf(r.url);
    return host != null && (allow.has(host) || [...allow].some((d) => host.endsWith('.' + d)));
  });
  const dropped = rows.length - onAllowlist.length;
  if (dropped > 0) console.log('[web-fallback] scoped prong dropped off-allowlist URLs', { conceptTitle, dropped });
  return onAllowlist;
}

// The allowlist = curated Source domains (docs/courseware/textbook/educator), minus
// YouTube (the Data API prong owns video) and the blanket community buckets. Read
// from the DB so an operator adding a Source widens the allowlist with no code change.
async function loadAllowlistDomains(): Promise<string[]> {
  const sources = await prisma.source.findMany({
    where: { kind: { in: ['official_docs', 'course_platform', 'textbook', 'educator'] } },
    select: { url: true },
  });
  const domains = new Set<string>();
  for (const s of sources) {
    const host = hostnameOf(s.url);
    if (host && host !== 'youtube.com' && !host.endsWith('.youtube.com')) domains.add(host);
  }
  return [...domains];
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ── discovery: rung 2 (open-web relaxation) ───────────────────────────────────

// Phase 2.5f: concept-focused discovery — find resources that TEACH one concept,
// within its topic for context. Biased toward `teaches` (remediation needs a
// qualifying primary), but otherwise the same grounded-search engine.
async function discoverForConcept(
  topic: string,
  conceptTitle: string,
  oversample: number,
  denyList: string[],
  targetMastery?: Difficulty,
  preferSubstantial = false,
  abortSignal?: AbortSignal,
): Promise<DiscoveredResource[]> {
  return runDiscovery({
    label: `${topic}::${conceptTitle}`,
    oversample,
    denyListSize: denyList.length,
    system: CONCEPT_DISCOVERY_SYSTEM_PROMPT,
    prompt: buildConceptDiscoveryPrompt(topic, conceptTitle, oversample, denyList, targetMastery, preferSubstantial),
    abortSignal,
  });
}

// One grounded-search discovery call + parse, shared by both prompts. Grounded
// search + structured output don't compose in the AI SDK today — ask for JSON in a
// fenced block and parse manually.
async function runDiscovery(args: {
  label: string;
  oversample: number;
  denyListSize: number;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<DiscoveredResource[]> {
  const { model, temperature, maxOutputTokens } = getModel('curriculumFallback');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    tools: { google_search: vertex.tools.googleSearch({}) },
    system: args.system,
    prompt: args.prompt,
    abortSignal: args.abortSignal,
  });

  recordUsage('web-fallback.discovery', result.usage);

  console.log('[web-fallback] discovery call', {
    label: args.label,
    oversample: args.oversample,
    denyListSize: args.denyListSize,
    sourceCount: result.sources?.length ?? 0,
    usage: result.usage,
    finishReason: result.finishReason,
  });

  const parsed = parseJsonArray(result.text);
  const valid: DiscoveredResource[] = [];
  for (const item of parsed) {
    const r = DiscoveredResourceSchema.safeParse(item);
    if (r.success) valid.push(r.data);
  }
  return valid;
}

// Shared discovery rules + output spec, so the topic and concept system prompts
// stay in lockstep (same validation contract, same anti-listicle rules).
const DISCOVERY_RULES = `Rules:
- Use Google Search to find real, currently-reachable URLs. Do NOT invent URLs.
- Prefer official documentation, well-known educators, university courseware (MIT OCW, Stanford CS, etc.), and recognized free textbook sites.
- AVOID sites that require login or paid signup for the main content (Coursera, DataCamp, Udemy, LinkedIn Learning, edX verified-track, Pluralsight).
- AVOID listicles, link aggregators, and "Top 10 X" roundup pages. The resource itself must teach the topic.
- AVOID marketing pages, course sales pages, and signup landing pages.
- conceptsTaught and rawConceptsTaught are the agent's first-pass tags; concise, lowercase, hyphen-separated (e.g. "linear-regression", "list-comprehensions"). 3-8 per resource.
- prerequisiteConcepts use the same vocabulary style; 0-5 per resource.
- durationMin is your best estimate of time to consume end-to-end in minutes.`;

const DISCOVERY_OUTPUT = `Output: a single JSON array in a \`\`\`json fenced block. No prose before or after. Each element:
{
  "url": string,
  "title": string,
  "type": "article" | "video" | "course" | "interactive" | "docs" | "book",
  "difficulty": "beginner" | "intermediate" | "advanced",
  "durationMin": number,
  "summary": string (1-2 sentences),
  "rawPrerequisiteConcepts": string[],
  "rawConceptsTaught": string[]
}`;

const CONCEPT_DISCOVERY_SYSTEM_PROMPT = `You are a learning-resource scout. Given a SPECIFIC CONCEPT within a topic, find authoritative free or freemium resources that TEACH that concept, using Google Search.

${DISCOVERY_RULES}
- PRIORITIZE resources that teach the target concept as a primary subject, from the ground up — not ones that merely use, apply, or mention it in passing.
- The concept's broader topic is context for disambiguation; the resource must be about the CONCEPT, not the whole topic.
- rawConceptsTaught must include the target concept (or its obvious synonym) for a genuine match.

${DISCOVERY_OUTPUT}`;

function buildConceptDiscoveryPrompt(
  topic: string,
  conceptTitle: string,
  oversample: number,
  denyList: string[],
  targetMastery?: Difficulty,
  preferSubstantial = false,
): string {
  const lines = [
    `Target concept: ${conceptTitle}`,
    `Topic (context): ${topic}`,
    `Target count: ${oversample} resources that TEACH "${conceptTitle}". Use Google Search.`,
  ];
  if (targetMastery) {
    // The in-track thickener sources because the existing material is too shallow
    // for the learner's target mastery — bias discovery toward that depth (but
    // don't hard-exclude adjacent levels; the composer makes the final pick).
    lines.push(
      `Target learner level: ${targetMastery}. Prefer resources pitched at or approaching ${targetMastery} depth (adjacent levels are acceptable if strong).`,
    );
  }
  appendSubstantialBias(lines, preferSubstantial);
  appendDenyList(lines, denyList);
  return lines.join('\n');
}

// Rung-1 grounded prompt: the same concept-discovery prompt, but constrained to the
// allowlisted domains. The model is told to search those sites specifically (site:
// queries); discoverForConceptScoped still hard-filters the result by host, so this
// is a strong steer rather than the guarantee.
function buildScopedConceptDiscoveryPrompt(
  topic: string,
  conceptTitle: string,
  oversample: number,
  denyList: string[],
  allowDomains: string[],
  targetMastery?: Difficulty,
  preferSubstantial = false,
): string {
  const lines = [
    `Target concept: ${conceptTitle}`,
    `Topic (context): ${topic}`,
    `Target count: ${oversample} resources that TEACH "${conceptTitle}". Use Google Search.`,
    '',
    'RESTRICT your search to these trusted domains ONLY — use site: filters (e.g. `site:docs.python.org eigenvalues`). Do NOT return URLs from any other domain; a result off this list will be discarded:',
    JSON.stringify(allowDomains),
  ];
  if (targetMastery) {
    lines.push(
      `Target learner level: ${targetMastery}. Prefer resources pitched at or approaching ${targetMastery} depth (adjacent levels are acceptable if strong).`,
    );
  }
  appendSubstantialBias(lines, preferSubstantial);
  appendDenyList(lines, denyList);
  return lines.join('\n');
}

// Budget-fill Block 2: the substantial-duration steer for budget-thin concepts.
// The existing candidates are short clips that can't fill a deep-tier core, so
// surfacing more of the same wastes the sourcing round.
function appendSubstantialBias(lines: string[], preferSubstantial: boolean): void {
  if (!preferSubstantial) return;
  lines.push(
    'Prefer SUBSTANTIAL resources a learner can spend real time with - full lessons, chapters, or in-depth videos of roughly 20-90 minutes. Avoid short overview clips (under ~10 minutes); the concept already has those.',
  );
}

function appendDenyList(lines: string[], denyList: string[]): void {
  if (denyList.length === 0) return;
  lines.push('');
  lines.push('Do NOT return any of the following URLs (already tried this run):');
  lines.push(JSON.stringify(denyList));
}

// ── canonicalization ────────────────────────────────────────────────────────

async function canonicalizeTags(
  discovered: DiscoveredResource[],
  vocab: string[],
  abortSignal?: AbortSignal,
): Promise<Map<string, { prerequisiteConcepts: string[]; conceptsTaught: string[] }>> {
  if (discovered.length === 0) return new Map();
  const { model, temperature, maxOutputTokens } = getModel('tagCanonicalizer');

  const input = discovered.map((d) => ({
    url: d.url,
    rawPrerequisiteConcepts: d.rawPrerequisiteConcepts,
    rawConceptsTaught: d.rawConceptsTaught,
  }));

  const map = new Map<string, { prerequisiteConcepts: string[]; conceptsTaught: string[] }>();

  // Canonicalization is a best-effort normalization pass, not a correctness
  // gate: every caller already falls back to the row's raw tags when a URL is
  // missing from this map (see the `?? { rawPrerequisiteConcepts, ... }`
  // default in persistDiscovered). A failure here — most commonly the model
  // capping mid-JSON on a large batch, which surfaces as AI_JSONParseError
  // ("Unterminated string in JSON") from generateObject — must therefore
  // degrade to raw tags, NOT crash the whole cold-topic fallback flow and
  // fail the worker's remediation run. Return whatever we got
  // (empty on total failure); the raw-tag default covers the rest.
  try {
    const result = await generateObject({
      model,
      temperature,
      maxOutputTokens,
      abortSignal,
      schema: CanonicalizedTagsSchema,
      system: CANON_SYSTEM_PROMPT,
      prompt: [
        'Existing topic vocabulary (canonical tags already used by this topic):',
        vocab.length > 0 ? JSON.stringify(vocab) : '(empty — this topic has no library yet)',
        '',
        'Resources to canonicalize:',
        JSON.stringify(input, null, 2),
      ].join('\n'),
    });

    for (const r of result.object.results) {
      map.set(r.url, { prerequisiteConcepts: r.prerequisiteConcepts, conceptsTaught: r.conceptsTaught });
    }
  } catch (err) {
    // A job abort is NOT a canonicalization fault — rethrow instead of degrading
    // to raw tags and letting the zombie run continue into the upsert loop.
    if (abortSignal?.aborted) throw err;
    console.warn('[web-fallback] canonicalize failed, degrading to raw tags', {
      count: discovered.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return map;
}

const CANON_SYSTEM_PROMPT = `You normalize concept tags for a per-topic learning-resource library.

Rules:
- For each input resource, return a results entry keyed by the resource's url.
- For every raw tag: if there is an obvious match in the existing topic vocabulary (same concept, different phrasing/casing/separator), map it to the existing tag verbatim. Otherwise, keep it but normalize to lowercase, hyphen-separated, no surrounding punctuation.
- Be conservative: only collapse tags that clearly refer to the same concept. When in doubt, pass through the normalized raw tag — do not invent merges.
- Preserve the split between prerequisiteConcepts and conceptsTaught.
- Drop empty/whitespace-only tags.`;

// ── helpers ─────────────────────────────────────────────────────────────────

function parseJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
