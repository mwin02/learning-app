// Phase 2g-3: generate the orientation on-ramp lesson with Gemini instead of
// sourcing it.
//
// Atomic YouTube/docs sourcing loses the natural "Lesson 1" intro the old course-
// decomposition model gave: the on-ramp concept (Concept.isOnRamp — the single broad
// "get an absolute beginner started" node) either attracts a whole-subject course as
// a false "intro" (the python 2h "Full Course") or finds nothing qualifying (the
// javascript-react on-ramp, 0 candidates). So for THIS one deliberate exception we
// author the primary ourselves: a short, scoped orientation lesson stored as a
// `generated` Resource. Genuinely-good sourced orientation (docs quick-starts) still
// rides alongside as alternates — this only owns the primary slot.
//
// Generation is on-ramp ONLY. We do NOT generalize content authoring to arbitrary
// concepts: the curation-first architecture (source + judge real resources) is the
// rule; the on-ramp is the single exception where no good atomic resource exists to
// source. The result is an `origin = generated`, `active`, `atomic` (pickable) row
// with a synthetic `generated://<topic>/<slug>` url, so regeneration is idempotent
// (the url is @unique) and the row never collides with a real external page.
//
// Two model passes: an AUTHOR draft, then an ACCURACY self-critique that corrects
// factual slips before the row goes `active` (these are written un-reviewed by a
// human, so the critique is the quality gate). Trust is a fixed source-reputation
// prior (no engagement signal yet) composed through the standard trust seam.

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/ai/models';
import { safeEmbedResource } from '@/lib/ai/embeddings';
import { computeTrustScore } from '@/lib/curation/trust-score';
import type { SearchResult } from '@/lib/agents/tools/search-resources';

const ONRAMP_MIN_READ = 5;
const ONRAMP_MAX_READ = 20;
const READING_WPM = 200;

const LessonSchema = z.object({
  // A concise, learner-facing lesson title (NOT the verbose concept title).
  title: z.string().min(1),
  // One-sentence summary — fuels search/judge ranking alongside the title.
  summary: z.string().min(1),
  // The lesson body, in markdown.
  content: z.string().min(1),
});
type Lesson = z.infer<typeof LessonSchema>;

// Generate (or reuse) the on-ramp lesson for one concept. Idempotent: a second call
// for the same topic+concept returns the already-stored row without re-authoring.
// Returns the row as a SearchResult so the caller can inject it directly as a
// candidate (it can't be discovered via searchResources in the same run — its
// embedding lands post-commit). Returns null if authoring fails, so callers degrade
// to ordinary sourcing.
export async function generateOnRampResource(args: {
  topic: string;
  concept: { slug: string; title: string };
}): Promise<SearchResult | null> {
  const { topic, concept } = args;
  const url = `generated://${topic}/${concept.slug}`;

  const existing = await prisma.resource.findUnique({ where: { url }, select: RESOURCE_SELECT });
  if (existing) {
    console.log('[onramp-gen] reusing existing generated lesson', { topic, concept: concept.slug });
    return toSearchResult(existing);
  }

  // Retry once on a thrown failure: Gemini 2.5 Pro intermittently spends its whole
  // output budget on internal thinking and emits nothing ("No output generated"), a
  // transient fault a second attempt usually clears (mirrors attachOneWithRetry). Only
  // after a second failure do we degrade to null and let the caller source instead.
  let lesson: Lesson;
  try {
    lesson = await authorAndCritique(topic, concept.title);
  } catch (err) {
    console.warn('[onramp-gen] authoring failed, retrying once', {
      topic,
      concept: concept.slug,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      lesson = await authorAndCritique(topic, concept.title);
    } catch (err2) {
      console.error('[onramp-gen] authoring failed after retry; caller will fall back to sourcing', {
        topic,
        concept: concept.slug,
        error: err2 instanceof Error ? err2.message : String(err2),
      });
      return null;
    }
  }

  const durationMin = readingTimeMin(lesson.content);
  const source = await loadGeneratedSource();
  const trustScore = computeTrustScore({ base: source.trustScore, signals: [] });
  const slug = `${topic}-${concept.slug}-onramp`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

  let created;
  try {
    created = await prisma.resource.create({
      data: {
        slug,
        topic,
        title: lesson.title,
        url,
        type: 'article',
        durationMin,
        summary: lesson.summary,
        content: lesson.content,
        difficulty: 'beginner',
        prerequisiteConcepts: [],
        conceptsTaught: [concept.title],
        origin: 'generated',
        // Our own vetted (self-critiqued) content — active/pickable immediately, not
        // queued for human review like an agent web find.
        status: 'active',
        decompositionStatus: 'atomic',
        trustScore,
        sourceId: source.id,
      },
      select: RESOURCE_SELECT,
    });
  } catch (err) {
    // A concurrent generator may have inserted the same url first; reuse theirs.
    const raced = await prisma.resource.findUnique({ where: { url }, select: RESOURCE_SELECT });
    if (raced) return toSearchResult(raced);
    console.error('[onramp-gen] persist failed', { topic, concept: concept.slug, error: (err as Error).message });
    return null;
  }

  // Best-effort embed post-commit (matches upsert-resource): lets the row surface in
  // FUTURE searches/other paths. The cold build that triggered generation injects it
  // directly, so it doesn't depend on this landing.
  await safeEmbedResource(created.id, { title: created.title, summary: created.summary, conceptsTaught: created.conceptsTaught });

  console.log('[onramp-gen] authored generated lesson', { topic, concept: concept.slug, durationMin, trustScore });
  return toSearchResult(created);
}

// ── model passes ──────────────────────────────────────────────────────────────

// One full generation: author a draft, then accuracy-critique it. Wrapped so the
// caller can retry the whole sequence on a transient model fault.
async function authorAndCritique(topic: string, conceptTitle: string): Promise<Lesson> {
  const draft = await authorLesson(topic, conceptTitle);
  return critiqueLesson(topic, conceptTitle, draft);
}

async function authorLesson(topic: string, conceptTitle: string): Promise<Lesson> {
  const { model, temperature, maxOutputTokens } = getModel('onRampAuthor');
  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: LessonSchema }),
    system: AUTHOR_SYSTEM,
    prompt: `Topic: ${topic}\nOrientation concept: ${conceptTitle}\n\nWrite the orientation on-ramp lesson for this topic.`,
  });
  return result.experimental_output;
}

async function critiqueLesson(topic: string, conceptTitle: string, draft: Lesson): Promise<Lesson> {
  const { model, temperature, maxOutputTokens } = getModel('onRampCritic');
  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: LessonSchema }),
    system: CRITIC_SYSTEM,
    prompt: [
      `Topic: ${topic}`,
      `Orientation concept: ${conceptTitle}`,
      '',
      'Draft lesson to fact-check and correct:',
      JSON.stringify(draft, null, 2),
    ].join('\n'),
  });
  return result.experimental_output;
}

const AUTHOR_SYSTEM = `You write the ORIENTATION / ON-RAMP lesson that gets an absolute beginner started in a subject — the deliberate "Lesson 1" that every later concept builds on.

Scope it to orientation, not a full course. Cover, as the subject warrants:
- what the subject is and why it matters (the core mental model / big picture);
- the essential vocabulary or notation a newcomer needs to read everything that follows;
- how to set up / run / read it — for a programming topic, environment setup and a first tiny program; for a math topic, notation and prerequisite review (NOT tooling);
- the very first concrete steps, so the learner finishes oriented and ready for the first substantive concept.

Rules:
- Be accurate and concrete. Prefer a small, correct worked example over hand-waving.
- Keep it SHORT — a focused orientation a beginner reads in ~5–12 minutes (roughly 500–900 words), not an exhaustive treatment. Depth belongs to later concepts.
- Write the body as clean markdown (headings, short paragraphs, lists, fenced code where it helps). Do NOT include the title as an H1 — the title is a separate field.
- Assume no prior knowledge of the subject; do not assume prerequisites the on-ramp itself should cover.`;

const CRITIC_SYSTEM = `You are a meticulous fact-checker for an orientation lesson aimed at absolute beginners. You are given a draft lesson (title, summary, markdown content).

Correct any FACTUAL errors: wrong definitions, incorrect or non-runnable code, outdated setup/installation instructions, mis-stated notation, off-by-one or sign errors in examples, false claims about the subject.

Constraints:
- PRESERVE the lesson's scope, structure, length, and beginner-friendly tone. Do not expand it into a full course or rewrite for style — change only what is inaccurate or genuinely misleading.
- If the draft is already accurate, return it unchanged.
- Return the full corrected lesson in the same shape (title, summary, content as markdown).`;

// ── helpers ─────────────────────────────────────────────────────────────────

// Minutes to read the content end-to-end, clamped to a short orientation window so a
// generated lesson reliably wins the on-ramp duration bias (2g-1) over long sourced
// courses, and never reports an implausible sub-minute or half-hour read.
function readingTimeMin(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const mins = Math.round(words / READING_WPM);
  return Math.min(ONRAMP_MAX_READ, Math.max(ONRAMP_MIN_READ, mins));
}

// The synthetic source for generated content — upserted on demand (mirrors the
// web/youtube blanket rows in upsert-resource). trustScore 0.8: a solid prior for our
// own self-critiqued orientation, below a canonical publisher but above open web.
async function loadGeneratedSource(): Promise<{ id: string; trustScore: number }> {
  return prisma.source.upsert({
    where: { slug: 'generated' },
    update: {},
    create: { slug: 'generated', name: 'AI-generated (on-ramp)', url: 'generated://', kind: 'generated', trustScore: 0.8 },
    select: { id: true, trustScore: true },
  });
}

const RESOURCE_SELECT = {
  id: true, slug: true, topic: true, title: true, url: true, type: true, tier: true,
  difficulty: true, durationMin: true, summary: true, prerequisiteConcepts: true,
  conceptsTaught: true, requiresPurchase: true, trustScore: true, decompositionStatus: true,
} as const;

type ResourceRow = {
  id: string; slug: string; topic: string; title: string; url: string; type: string; tier: string;
  difficulty: string; durationMin: number; summary: string; prerequisiteConcepts: string[];
  conceptsTaught: string[]; requiresPurchase: boolean; trustScore: number; decompositionStatus: string;
};

function toSearchResult(r: ResourceRow): SearchResult {
  return { ...r, distance: null };
}
