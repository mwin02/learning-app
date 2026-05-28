// Web fallback for the curriculum agent.
//
// Triggered by `loadCandidates` in curriculum-agent.ts when a topic's active
// Resource count is below FALLBACK_THRESHOLD. Loops Vertex-grounded discovery
// against the validation pipeline (liveness + rules-agent) with a growing
// deny-list until either FALLBACK_TARGET_COUNT survivors are collected or
// FALLBACK_MAX_DISCOVERY_ITERATIONS is hit. Survivors get canonicalized tags
// and are upserted as Resource(origin='agent', status='pending_review').
//
// Locked by ROADMAP: grounded search via Vertex's googleSearch tool, NOT an
// agent-with-tools loop. The "loop" here is in the application layer
// (discover → validate → maybe re-discover), not handed to the model.

import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/models';
import { vertex } from '@/lib/vertex';
import {
  FALLBACK_DISCOVERY_OVERSAMPLE,
  FALLBACK_MAX_DISCOVERY_ITERATIONS,
} from '@/lib/config';
import { runValidationPipeline } from '@/lib/validation';
import { livenessValidator } from '@/lib/validation/validators/liveness';
import { rulesAgentValidator } from '@/lib/validation/validators/rules-agent';
import type { ResourceType, Difficulty } from '@prisma/client';

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
};

const VALIDATORS = [livenessValidator, rulesAgentValidator];

export async function runWebFallback({
  topic,
  targetCount,
}: {
  topic: string;
  targetCount: number;
}): Promise<WebFallbackResult> {
  const survivors = new Map<string, DiscoveredResource>();
  const denyList = new Set<string>();
  let iterations = 0;
  let totalDiscovered = 0;

  while (survivors.size < targetCount && iterations < FALLBACK_MAX_DISCOVERY_ITERATIONS) {
    iterations += 1;
    const need = targetCount - survivors.size;

    const discovered = await discoverResources(topic, FALLBACK_DISCOVERY_OVERSAMPLE, [...denyList]);
    totalDiscovered += discovered.length;

    // Always block URLs we've already seen this run from re-discovery, even
    // if validation drops them — no point spending tokens twice.
    for (const r of discovered) denyList.add(r.url);

    // Skip rows already-known-good in this loop (model could re-surface them
    // in iteration 2+ if Google Search returns them).
    const fresh = discovered.filter((r) => !survivors.has(r.url));
    if (fresh.length === 0) {
      console.log('[web-fallback] iteration produced no fresh URLs', { topic, iteration: iterations });
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
      topic,
      iteration: iterations,
      discovered: discovered.length,
      fresh: fresh.length,
      valid: valid.length,
      survivors: survivors.size,
      need,
    });
  }

  const finalRows = [...survivors.values()];
  if (finalRows.length === 0) {
    console.log('[web-fallback] no survivors', { topic, iterations, totalDiscovered });
    return { insertedCount: 0, skippedCount: 0, discoveredCount: totalDiscovered, iterations };
  }

  const vocab = await loadTopicVocab(topic);
  const canonical = await canonicalizeTags(finalRows, vocab);

  let insertedCount = 0;
  let skippedCount = 0;
  for (const row of finalRows) {
    const tags = canonical.get(row.url) ?? {
      prerequisiteConcepts: row.rawPrerequisiteConcepts,
      conceptsTaught: row.rawConceptsTaught,
    };
    const ok = await upsertResource(topic, row, tags);
    if (ok) insertedCount += 1;
    else skippedCount += 1;
  }

  console.log('[web-fallback] summary', {
    topic,
    iterations,
    discoveredCount: totalDiscovered,
    survivors: finalRows.length,
    insertedCount,
    skippedCount,
    targetMet: finalRows.length >= targetCount,
  });
  return { insertedCount, skippedCount, discoveredCount: totalDiscovered, iterations };
}

// ── discovery ───────────────────────────────────────────────────────────────

async function discoverResources(
  topic: string,
  oversample: number,
  denyList: string[],
): Promise<DiscoveredResource[]> {
  const { model, temperature, maxOutputTokens } = getModel('curriculumFallback');

  // Grounded search + structured output don't compose in the AI SDK today —
  // ask for JSON in a fenced block and parse manually.
  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    tools: { google_search: vertex.tools.googleSearch({}) },
    system: DISCOVERY_SYSTEM_PROMPT,
    prompt: buildDiscoveryPrompt(topic, oversample, denyList),
  });

  console.log('[web-fallback] discovery call', {
    topic,
    oversample,
    denyListSize: denyList.length,
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

const DISCOVERY_SYSTEM_PROMPT = `You are a learning-resource scout. Given a topic, find authoritative free or freemium learning resources on the open web using Google Search.

Rules:
- Use Google Search to find real, currently-reachable URLs. Do NOT invent URLs.
- Prefer official documentation, well-known educators, university courseware (MIT OCW, Stanford CS, etc.), and recognized free textbook sites.
- AVOID sites that require login or paid signup for the main content (Coursera, DataCamp, Udemy, LinkedIn Learning, edX verified-track, Pluralsight).
- AVOID listicles, link aggregators, and "Top 10 X" roundup pages. The resource itself must teach the topic.
- AVOID marketing pages, course sales pages, and signup landing pages.
- Cover a range of difficulties (beginner through advanced) and resource types (docs, video, article, course, book) where possible.
- conceptsTaught and rawConceptsTaught are the agent's first-pass tags; concise, lowercase, hyphen-separated (e.g. "linear-regression", "list-comprehensions"). 3-8 per resource.
- prerequisiteConcepts use the same vocabulary style; 0-5 per resource.
- durationMin is your best estimate of time to consume end-to-end in minutes.

Output: a single JSON array in a \`\`\`json fenced block. No prose before or after. Each element:
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

function buildDiscoveryPrompt(topic: string, oversample: number, denyList: string[]): string {
  const lines = [
    `Topic: ${topic}`,
    `Target count: ${oversample} resources.`,
    `Find a balanced spread across difficulty and resource type. Use Google Search.`,
  ];
  if (denyList.length > 0) {
    lines.push('');
    lines.push('Do NOT return any of the following URLs (already tried this run):');
    lines.push(JSON.stringify(denyList));
  }
  return lines.join('\n');
}

// ── canonicalization ────────────────────────────────────────────────────────

async function loadTopicVocab(topic: string): Promise<string[]> {
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

  const map = new Map<string, { prerequisiteConcepts: string[]; conceptsTaught: string[] }>();
  for (const r of result.object.results) {
    map.set(r.url, { prerequisiteConcepts: r.prerequisiteConcepts, conceptsTaught: r.conceptsTaught });
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

// ── upsert ──────────────────────────────────────────────────────────────────

async function upsertResource(
  topic: string,
  row: DiscoveredResource,
  tags: { prerequisiteConcepts: string[]; conceptsTaught: string[] },
): Promise<boolean> {
  const existing = await prisma.resource.findUnique({ where: { url: row.url }, select: { id: true, topic: true } });
  if (existing) {
    if (existing.topic !== topic) {
      console.log('[web-fallback] skip cross-topic URL collision', { url: row.url, existingTopic: existing.topic, requestedTopic: topic });
      return false;
    }
    return false;
  }

  const source = await resolveSource(row.url);
  const slug = await uniqueSlug(row.title, row.url);

  try {
    await prisma.resource.create({
      data: {
        slug,
        topic,
        title: row.title,
        url: row.url,
        type: row.type as ResourceType,
        durationMin: row.durationMin,
        summary: row.summary,
        difficulty: row.difficulty as Difficulty,
        prerequisiteConcepts: tags.prerequisiteConcepts,
        conceptsTaught: tags.conceptsTaught,
        origin: 'agent',
        status: 'pending_review',
        trustScore: source.trustScore,
        sourceId: source.id,
      },
    });
    return true;
  } catch (err) {
    console.log('[web-fallback] create failed', { url: row.url, error: (err as Error).message });
    return false;
  }
}

async function resolveSource(url: string): Promise<{ id: string; trustScore: number }> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return loadWebSource();
  }
  // Match a seeded Source whose own URL host equals or is a parent of this host.
  const candidates = await prisma.source.findMany({ select: { id: true, url: true, trustScore: true } });
  for (const s of candidates) {
    try {
      const sHost = new URL(s.url).hostname.replace(/^www\./, '');
      if (sHost && (sHost === host || host.endsWith('.' + sHost))) {
        return { id: s.id, trustScore: s.trustScore };
      }
    } catch {
      // Skip sources with non-URL `url` (the 'web' blanket row has url='https://').
    }
  }
  return loadWebSource();
}

async function loadWebSource(): Promise<{ id: string; trustScore: number }> {
  const web = await prisma.source.upsert({
    where: { slug: 'web' },
    update: {},
    create: { slug: 'web', name: 'Open web (agent-discovered)', url: 'https://', kind: 'community', trustScore: 0.4 },
    select: { id: true, trustScore: true },
  });
  return web;
}

async function uniqueSlug(title: string, url: string): Promise<string> {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'resource';
  const candidate = base;
  const existing = await prisma.resource.findUnique({ where: { slug: candidate }, select: { id: true } });
  if (!existing) return candidate;
  // Disambiguate with a short hash of the URL.
  let hash = 0;
  for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return `${candidate}-${(hash >>> 0).toString(36).slice(0, 6)}`;
}

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
