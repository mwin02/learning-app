// Targeted per-concept web sourcing.
//
//   sourceForConcept({ topic, concept }) — Phase 2.5f targeted per-concept
//     sourcing for spine-hole remediation + the in-track thickener: find resources
//     that TEACH one specific concept. Returns insertedIds so the remediation
//     re-judge (2.5f-3) can attach them by id without waiting on the post-commit
//     embed.
//
// This was once a two-entry-point module — the topic-level scattershot
// `runWebFallback` (the old generate-path library-floor fallback) shared this same
// discover → validate → maybe re-discover engine + decompose → canonicalize → file
// → upsert tail. That entry retired in the Phase 2.5g cutover: under the concept-
// map/Track architecture, library growth is driven by TARGETED per-concept sourcing,
// not coarse per-topic dumps. The shared engine (collectSurvivors / persistDiscovered
// / runDiscovery) stays — sourceForConcept is now its only caller.
//
// Locked by ROADMAP: grounded search via Vertex's googleSearch tool, NOT an
// agent-with-tools loop. The "loop" here is in the application layer
// (discover → validate → maybe re-discover), not handed to the model.

import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import type { Difficulty } from '@prisma/client';
import { getModel } from '@/lib/ai/models';
import { vertex } from '@/lib/ai/vertex';
import {
  REMEDIATION_SOURCE_TARGET_COUNT,
  REMEDIATION_DISCOVERY_OVERSAMPLE,
  REMEDIATION_MAX_DISCOVERY_ITERATIONS,
} from '@/lib/config';
import { runValidationPipeline } from '@/lib/agents/validation';
import { livenessValidator } from '@/lib/agents/validation/validators/liveness';
import { rulesAgentValidator } from '@/lib/agents/validation/validators/rules-agent';
import { decompose } from '@/lib/agents/decomposition/decompose';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { loadTopicVocab } from '@/lib/agents/decomposition/concepts';
import { classifyDiscoveryTopics } from '@/lib/agents/tools/classify-topic';
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

const VALIDATORS = [livenessValidator, rulesAgentValidator];

// Phase 2.5f: source resources that TEACH one specific concept, for spine-hole
// remediation and the in-track thickener. Same engine + persistence tail as the
// topic fallback, but a concept-focused discovery prompt and a tighter budget.
// Returns insertedIds so the re-judge can attach via searchResources({ includeIds })
// before the post-commit embed lands. `targetMastery` (set by the in-track
// thickener, omitted by mastery-agnostic spine-hole remediation) biases discovery
// toward that learner level.
export async function sourceForConcept({
  topic,
  concept,
  targetCount = REMEDIATION_SOURCE_TARGET_COUNT,
  targetMastery,
}: {
  topic: string;
  concept: { slug: string; title: string };
  targetCount?: number;
  targetMastery?: Difficulty;
}): Promise<WebFallbackResult> {
  const label = `${topic}::${concept.slug}`;
  const { survivors, iterations, totalDiscovered } = await collectSurvivors({
    label,
    targetCount,
    oversample: REMEDIATION_DISCOVERY_OVERSAMPLE,
    maxIterations: REMEDIATION_MAX_DISCOVERY_ITERATIONS,
    discover: (oversample, denyList) => discoverForConcept(topic, concept.title, oversample, denyList, targetMastery),
  });
  return persistDiscovered(topic, survivors, { label, iterations, totalDiscovered, targetCount });
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
  discover: (oversample: number, denyList: string[]) => Promise<DiscoveredResource[]>;
}): Promise<{ survivors: DiscoveredResource[]; iterations: number; totalDiscovered: number }> {
  const { label, targetCount, oversample, maxIterations, discover } = args;
  const survivors = new Map<string, DiscoveredResource>();
  const denyList = new Set<string>();
  let iterations = 0;
  let totalDiscovered = 0;

  while (survivors.size < targetCount && iterations < maxIterations) {
    iterations += 1;
    const need = targetCount - survivors.size;

    const discovered = await discover(oversample, [...denyList]);
    totalDiscovered += discovered.length;

    // Always block URLs we've already seen this run from re-discovery, even
    // if validation drops them — no point spending tokens twice.
    for (const r of discovered) denyList.add(r.url);

    // Skip rows already-known-good in this loop (model could re-surface them
    // in iteration 2+ if Google Search returns them).
    const fresh = discovered.filter((r) => !survivors.has(r.url));
    if (fresh.length === 0) {
      console.log('[web-fallback] iteration produced no fresh URLs', { label, iteration: iterations });
      continue;
    }

    const { valid, rejected } = await runValidationPipeline<DiscoveredResource>(fresh, VALIDATORS);

    for (const r of rejected) {
      console.log('[web-fallback] rejected', { url: r.row.url, validator: r.validator, reason: r.reason });
    }

    for (const r of valid) {
      if (survivors.size >= targetCount) break;
      survivors.set(r.url, r);
    }

    console.log('[web-fallback] iteration', {
      label,
      iteration: iterations,
      discovered: discovered.length,
      fresh: fresh.length,
      valid: valid.length,
      survivors: survivors.size,
      need,
    });
  }

  return { survivors: [...survivors.values()], iterations, totalDiscovered };
}

// The persistence tail shared by both entry points: decompose → canonicalize →
// file under home topic → upsert. `topic` is the request topic (the filing anchor);
// survivors are filed under topic ∪ related per the classifier.
async function persistDiscovered(
  topic: string,
  finalRows: DiscoveredResource[],
  meta: { label: string; iterations: number; totalDiscovered: number; targetCount: number },
): Promise<WebFallbackResult> {
  const { label, iterations, totalDiscovered, targetCount } = meta;
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
      }),
    })),
  );

  // Canonicalize concepts only for atomic survivors. Container parents are
  // unpickable, so their own concepts don't drive selection or dedup — per
  // decision A, canonicalization for a container's children happens inside the
  // router (concepts.ts), not here.
  const atomicRows = decomposed
    .filter((d) => d.result.status === 'atomic')
    .map((d) => d.row);
  const vocab = await loadTopicVocab(topic);
  const canonical = await canonicalizeTags(atomicRows, vocab);

  // File each survivor under its home topic rather than blindly stamping the
  // request topic. Bounded to the request topic ∪ its related topics; a single
  // candidate (the common case) skips the classifier entirely. Decomposed
  // children inherit the parent's filed topic via createChild.
  const candidateTopics = relatedTopics(topic);
  const filedTopicByUrl =
    candidateTopics.length > 1
      ? await classifyDiscoveryTopics(
          finalRows.map((r) => ({
            url: r.url,
            title: r.title,
            summary: r.summary,
            conceptsTaught: r.rawConceptsTaught,
          })),
          candidateTopics,
          topic,
        )
      : new Map<string, string>();

  let insertedCount = 0;
  let skippedCount = 0;
  let reclassifiedCount = 0;
  const insertedIds: string[] = [];
  for (const { row, result } of decomposed) {
    const tags = canonical.get(row.url) ?? {
      prerequisiteConcepts: row.rawPrerequisiteConcepts,
      conceptsTaught: row.rawConceptsTaught,
    };
    const filedTopic = filedTopicByUrl.get(row.url) ?? topic;
    if (filedTopic !== topic) reclassifiedCount += 1;
    const { outcome, atomicIds } = await upsertResource(
      filedTopic,
      {
        url: row.url,
        title: row.title,
        type: row.type,
        difficulty: row.difficulty,
        durationMin: row.durationMin,
        summary: row.summary,
        prerequisiteConcepts: tags.prerequisiteConcepts,
        conceptsTaught: tags.conceptsTaught,
      },
      result,
    );
    if (outcome === 'inserted') insertedCount += 1;
    else skippedCount += 1;
    insertedIds.push(...atomicIds);
  }

  console.log('[web-fallback] summary', {
    label,
    iterations,
    discoveredCount: totalDiscovered,
    survivors: finalRows.length,
    insertedCount,
    skippedCount,
    reclassifiedCount,
    targetMet: finalRows.length >= targetCount,
  });
  return { insertedCount, skippedCount, discoveredCount: totalDiscovered, iterations, insertedIds };
}

// ── discovery ───────────────────────────────────────────────────────────────

// Phase 2.5f: concept-focused discovery — find resources that TEACH one concept,
// within its topic for context. Biased toward `teaches` (remediation needs a
// qualifying primary), but otherwise the same grounded-search engine.
async function discoverForConcept(
  topic: string,
  conceptTitle: string,
  oversample: number,
  denyList: string[],
  targetMastery?: Difficulty,
): Promise<DiscoveredResource[]> {
  return runDiscovery({
    label: `${topic}::${conceptTitle}`,
    oversample,
    denyListSize: denyList.length,
    system: CONCEPT_DISCOVERY_SYSTEM_PROMPT,
    prompt: buildConceptDiscoveryPrompt(topic, conceptTitle, oversample, denyList, targetMastery),
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
}): Promise<DiscoveredResource[]> {
  const { model, temperature, maxOutputTokens } = getModel('curriculumFallback');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    tools: { google_search: vertex.tools.googleSearch({}) },
    system: args.system,
    prompt: args.prompt,
  });

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
  appendDenyList(lines, denyList);
  return lines.join('\n');
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
  // bubble a 500 out of POST /api/generate-path. Return whatever we got
  // (empty on total failure); the raw-tag default covers the rest.
  try {
    const result = await generateObject({
      model,
      temperature,
      maxOutputTokens,
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
