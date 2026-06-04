// Phase 2.5b-3 — doc-site table-of-contents router.
//
// Explodes a doc-course container page (MIT OCW course, Python tutorial, MDN
// guide tree, …) into atomic per-section child Resources. Approach (decided in
// discussion, "option b + validation"):
//   1. fetch the page HTML (plain fetch + real UA; no parser dependency)
//   2. extract the page title, a stripped body-text snippet, and every same-
//      origin anchor link (href + visible text)
//   3. an LLM SELECTS from those real links which are the course's ordered
//      lesson sections — it can only pick URLs we extracted, so URL
//      hallucination is structurally impossible (we still assert ⊆ as a guard)
//   4. children re-derive their own concepts via concepts.ts (decision A)
//
// classify() routes here on type=course/interactive/docs, which is only the
// discovery agent's first-pass guess. So the page may not be a decomposable
// course at all. The LLM makes a three-way *pedagogical* judgment:
//   single_lesson    — one self-contained lesson/article → keep whole (atomic)
//   lesson_sequence  — ordered series of LESSON pages    → decompose
//   reference_index  — API/method/glossary lookup index  → keep whole (atomic)
// The reference_index case is the important one: an API reference (every string
// method on its own page, say) must NOT be shattered into per-method atomic
// fragments the curriculum agent would mis-pick and the Lesson layer can't
// sequence. It stays a single pickable resource. Bias is conservative: only
// lesson_sequence decomposes; when in doubt the page is kept whole.
//
// Outcome mapping (consumed by decompose()):
//   ok (lesson_sequence)             → 'decomposed' (+ children)
//   single_lesson / reference_index  → 'atomic'      (keep whole, pickable)
//   fetch / parse error              → 'pending'     (auto-retryable)
//   lesson_sequence, no usable sections → 'human_review' (needs curation)

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';
import { deriveChildConcepts } from './concepts';
import type { ChildInput } from './decompose';
import { DECOMPOSITION_MAX_AUTO_CHILDREN, DOC_TOC_MAX_HTML_CHARS } from '@/lib/config';

const FETCH_UA =
  'Mozilla/5.0 (compatible; LearningPathBot/1.0; +https://learning-app-three-amber.vercel.app)';
const MAX_CANDIDATE_LINKS = 300;
const BODY_SNIPPET_CHARS = 2000;

export type DocTocResult =
  | { ok: true; children: ChildInput[] }
  | { ok: false; outcome: 'atomic' | 'pending' | 'human_review'; reason: string };

type CandidateLink = { url: string; text: string };

const ExtractionSchema = z.object({
  pageKind: z.enum(['single_lesson', 'lesson_sequence', 'reference_index']),
  sections: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().min(1),
        summary: z.string().default(''),
        durationMin: z.number().int().min(1).max(6000).default(20),
      }),
    )
    .default([]),
});

export async function decomposeDocToc(args: {
  url: string;
  topic: string;
  difficulty: string;
  parentConcepts: string[];
  // Bypass the oversize gate (curation API force-decompose): decompose every
  // selected section however many, rather than bailing to human_review.
  force?: boolean;
}): Promise<DocTocResult> {
  const { url, topic, difficulty, parentConcepts, force = false } = args;

  let html: string;
  try {
    const res = await fetch(url, { headers: { 'user-agent': FETCH_UA, accept: 'text/html' } });
    if (!res.ok) return { ok: false, outcome: 'pending', reason: `HTTP ${res.status}` };
    html = (await res.text()).slice(0, DOC_TOC_MAX_HTML_CHARS);
  } catch (err) {
    return { ok: false, outcome: 'pending', reason: `fetch failed: ${(err as Error).message}` };
  }

  const title = extractTitle(html);
  const bodySnippet = extractBodyText(html).slice(0, BODY_SNIPPET_CHARS);
  const candidates = extractCandidateLinks(html, url).slice(0, MAX_CANDIDATE_LINKS);

  if (candidates.length === 0) {
    // No static section links at all — could be a JS-rendered index or a single
    // page. Can't decompose; let a human decide rather than guessing atomic.
    return { ok: false, outcome: 'human_review', reason: 'no extractable section links' };
  }

  let extraction: z.infer<typeof ExtractionSchema>;
  try {
    extraction = await extractToc(title, bodySnippet, candidates);
  } catch (err) {
    return { ok: false, outcome: 'pending', reason: `extraction failed: ${(err as Error).message}` };
  }

  // Only an ordered lesson sequence decomposes. A single lesson or a reference
  // index is kept whole as a pickable atomic resource — never fragmented.
  if (extraction.pageKind !== 'lesson_sequence') {
    return { ok: false, outcome: 'atomic', reason: `pageKind=${extraction.pageKind}` };
  }

  // Guard: keep only sections whose URL was actually one of the links we
  // extracted (defends against any invented URL), and dedup.
  const allowed = new Map(candidates.map((c) => [c.url, c]));
  const seen = new Set<string>();
  const valid = extraction.sections.filter((s) => {
    if (!allowed.has(s.url) || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  if (valid.length < 2) {
    // Classified as a sequence but we couldn't pin ≥2 distinct-URL sections
    // (anchors-only single page, JS-rendered, ambiguous) — needs a human.
    return { ok: false, outcome: 'human_review', reason: `only ${valid.length} usable section(s)` };
  }

  // Oversize gate: too many sections is usually LLM over-selection or a sprawling
  // tree — don't auto-decompose; let a human decide. Fires BEFORE the per-child
  // concept derivation, so the expensive half is skipped. `force` (curation API)
  // bypasses it for a section list the operator/agent has vouched for.
  if (!force && valid.length > DECOMPOSITION_MAX_AUTO_CHILDREN) {
    return {
      ok: false,
      outcome: 'human_review',
      reason: `${valid.length} sections (> ${DECOMPOSITION_MAX_AUTO_CHILDREN} auto-decompose limit) — needs review`,
    };
  }

  const concepts = await deriveChildConcepts({
    topic,
    parentConcepts,
    items: valid.map((s) => ({ ref: s.url, title: s.title, description: s.summary })),
  });

  const children: ChildInput[] = valid.map((s, idx) => {
    const derived = concepts.get(s.url);
    return {
      url: s.url,
      title: s.title,
      type: 'article',
      difficulty,
      durationMin: s.durationMin,
      summary: s.summary || s.title,
      prerequisiteConcepts: derived?.prerequisiteConcepts ?? [],
      conceptsTaught: derived?.conceptsTaught ?? (parentConcepts.length > 0 ? parentConcepts : [topic]),
      orderInParent: idx,
    };
  });

  return { ok: true, children };
}

// ── LLM selection ────────────────────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `You analyze one web page from a documentation or learning site and classify how it is structured. You are given the page title, a snippet of its body text, and the list of links found on the page (each with its visible text).

Classify the page into exactly one pageKind:

- "single_lesson": the page IS one self-contained lesson, article, or tutorial — its main body teaches one topic directly. The links are navigation/related material, NOT a table of contents.
- "lesson_sequence": the page is a course/tutorial/guide outline that lists multiple separate pages meant to be followed IN ORDER as progressive lessons (e.g. "Tutorial: Part 1, Part 2, …", "Chapter 1, 2, 3").
- "reference_index": the page indexes API entries, methods, functions, classes, configuration options, or glossary terms for LOOKUP — not progressive lessons (e.g. a "String methods" page linking to one page per method, an API reference, a function list).

Critical rules:
- Decompose (return sections) ONLY for "lesson_sequence". For "single_lesson" and "reference_index", return an empty sections list — those pages are kept whole.
- Reference material must NOT be treated as a lesson sequence: a list of methods/functions/API entries is "reference_index", even though it has many links. Splitting it into per-method pages is wrong.
- When in doubt between lesson_sequence and reference_index, choose reference_index (keep the page whole). Only decompose when you are confident the children are sequential learning lessons.

Rules for sections (only when pageKind is "lesson_sequence"):
- Choose ONLY from the provided links — copy their "url" verbatim. Never invent or modify a URL.
- Include only the actual ordered lesson/chapter pages. Exclude nav, login, search, social, "about", external/unrelated links, and the page's own URL.
- Put them in the order a learner should follow.
- title: a concise lesson title (you may clean up the link text). summary: one short sentence on what the section covers. durationMin: rough minutes to read/work through the section.
- If it is a lesson_sequence but you cannot identify distinct lesson pages among the links, return an empty sections list.`;

async function extractToc(
  title: string,
  bodySnippet: string,
  candidates: CandidateLink[],
): Promise<z.infer<typeof ExtractionSchema>> {
  const { model, temperature, maxOutputTokens } = getModel('docTocExtractor');
  const result = await generateObject({
    model,
    temperature,
    maxOutputTokens,
    schema: ExtractionSchema,
    system: EXTRACT_SYSTEM_PROMPT,
    prompt: [
      `Page title: ${title || '(none)'}`,
      '',
      'Body snippet:',
      bodySnippet || '(empty)',
      '',
      'Links found on the page:',
      JSON.stringify(candidates, null, 2),
    ].join('\n'),
  });
  return result.object;
}

// ── HTML extraction (regex; no parser dependency) ────────────────────────────

function extractTitle(html: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) return decodeEntities(stripTags(t[1])).trim();
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return h1 ? decodeEntities(stripTags(h1[1])).trim() : '';
}

function extractBodyText(html: string): string {
  const withoutHead = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  return decodeEntities(stripTags(withoutHead)).replace(/\s+/g, ' ').trim();
}

// Same-origin anchor links with their visible text, resolved to absolute URLs.
// Drops fragments/mailto/js and self-links; dedups by URL (first text wins).
function extractCandidateLinks(html: string, pageUrl: string): CandidateLink[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const out = new Map<string, string>();
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = m[1].trim();
    if (!rawHref || rawHref.startsWith('#') || /^(mailto:|javascript:|tel:)/i.test(rawHref)) continue;
    let resolved: URL;
    try {
      resolved = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (resolved.origin !== base.origin) continue;
    resolved.hash = '';
    const url = resolved.toString();
    if (url === base.toString()) continue;
    const text = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    if (!out.has(url)) out.set(url, text);
  }
  return [...out.entries()].map(([url, text]) => ({ url, text }));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
