// Web fallback for the curriculum agent.
//
// Triggered by `loadCandidates` in curriculum-agent.ts when a topic's active
// Resource count is below FALLBACK_THRESHOLD. Runs one grounded Vertex call
// to discover learning resources for the topic, one ungrounded canonicalization
// call to fold raw concept tags into the topic's existing vocab, then upserts
// the finds as `Resource(origin='agent', status='pending_review')`.
//
// Locked by ROADMAP: single grounded call + single canonicalization call. Not
// an agent-with-tools loop. Per-topic vocab. URL collisions across topics are
// skipped (Resource.url is @unique and Resource.topic is a single column).

import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/models';
import { vertex } from '@/lib/vertex';
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
};

export async function runWebFallback({
  topic,
  targetCount,
}: {
  topic: string;
  targetCount: number;
}): Promise<WebFallbackResult> {
  const discoveredRaw = await discoverResources(topic, targetCount);
  if (discoveredRaw.length === 0) {
    console.log('[web-fallback] no resources discovered', { topic });
    return { insertedCount: 0, skippedCount: 0, discoveredCount: 0 };
  }

  const discovered = await filterLiveUrls(discoveredRaw);
  console.log('[web-fallback] liveness filter', {
    topic,
    before: discoveredRaw.length,
    after: discovered.length,
    dropped: discoveredRaw.length - discovered.length,
  });
  if (discovered.length === 0) {
    return { insertedCount: 0, skippedCount: 0, discoveredCount: 0 };
  }

  const vocab = await loadTopicVocab(topic);
  const canonical = await canonicalizeTags(discovered, vocab);

  let insertedCount = 0;
  let skippedCount = 0;
  for (const row of discovered) {
    const tags = canonical.get(row.url) ?? {
      prerequisiteConcepts: row.rawPrerequisiteConcepts,
      conceptsTaught: row.rawConceptsTaught,
    };
    const ok = await upsertResource(topic, row, tags);
    if (ok) insertedCount += 1;
    else skippedCount += 1;
  }

  console.log('[web-fallback] done', { topic, discoveredCount: discovered.length, insertedCount, skippedCount });
  return { insertedCount, skippedCount, discoveredCount: discovered.length };
}

// ── discovery ───────────────────────────────────────────────────────────────

async function discoverResources(topic: string, targetCount: number): Promise<DiscoveredResource[]> {
  const { model, temperature, maxOutputTokens } = getModel('curriculumFallback');

  // Grounded search + structured output don't compose in the AI SDK today —
  // ask for JSON in a fenced block and parse manually.
  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    tools: { google_search: vertex.tools.googleSearch({}) },
    system: DISCOVERY_SYSTEM_PROMPT,
    prompt: buildDiscoveryPrompt(topic, targetCount),
  });

  console.log('[web-fallback] discovery call', {
    topic,
    targetCount,
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
- Prefer official documentation, well-known educators, university courseware, and recognized textbook sites.
- Cover a range of difficulties (beginner through advanced) and resource types (docs, video, article, course, book) where possible.
- Each resource must teach the topic directly — exclude marketing pages, paywalled landing pages with no preview, and link aggregators.
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

function buildDiscoveryPrompt(topic: string, targetCount: number): string {
  return [
    `Topic: ${topic}`,
    `Target count: ${targetCount} resources.`,
    `Find a balanced spread across difficulty and resource type. Use Google Search.`,
  ].join('\n');
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

// ── liveness ────────────────────────────────────────────────────────────────

// Drop URLs that don't resolve to a live page. The discovery model occasionally
// returns links to deleted YouTube videos, moved docs, or hallucinated paths
// on real domains; without this gate those land in pending_review and the
// sequencer happily includes them in paths.

const LIVENESS_TIMEOUT_MS = 6000;

async function filterLiveUrls(rows: DiscoveredResource[]): Promise<DiscoveredResource[]> {
  const checks = await Promise.all(rows.map(async (r) => ({ row: r, alive: await isUrlLive(r.url) })));
  return checks.filter((c) => c.alive).map((c) => c.row);
}

async function isUrlLive(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }

  // YouTube returns 200 with HTML even for removed videos. Use the oEmbed
  // endpoint, which returns 404 for unavailable videos.
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) {
    return checkYouTube(url);
  }

  return checkHttp(url);
}

async function checkHttp(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    if (head.ok) return true;
    // Some servers (incl. many docs hosts) reject HEAD with 403/405/501. Retry
    // with a Range GET that pulls a single byte.
    if ([403, 405, 501].includes(head.status)) {
      const get = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { Range: 'bytes=0-0' } });
      return get.ok || get.status === 206;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function checkYouTube(url: string): Promise<boolean> {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await fetch(oembed, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
