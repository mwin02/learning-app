// Phase 2.5-AR (AR-3): the autonomous retrieval half of the Hybrid curriculum
// agent. A bounded tool-calling loop lets the model gather candidate resources
// for a path — issuing searches across the topic's sub-skills, drilling into
// promising resources, and (within budget) triggering web fallback when the
// library lacks an area. It does NOT select or sequence; that's AR-4.
//
// Opaque handles: tools never expose Resource cuids. Each resource a tool
// surfaces is registered under a short session-scoped handle (r1, r2, …) and
// returned to the model by handle only. The handle→resource registry is the
// assembled candidate set; AR-4 resolves handles back to real ids when it
// persists. The model therefore cannot fabricate an id — it can only reference
// handles that a tool actually returned this session.

import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/models';
import { searchResources, type SearchResult } from '@/lib/search-resources';
import { runWebFallback } from '@/lib/web-fallback';
import type { CurriculumInput } from '@/lib/curriculum-agent';
import {
  FALLBACK_THRESHOLD,
  FALLBACK_TARGET_COUNT,
  RETRIEVAL_MAX_STEPS,
  RETRIEVAL_MAX_FALLBACKS,
} from '@/lib/config';

// Model-facing view of a candidate: a handle in place of the cuid, and only the
// fields the model needs to judge relevance. (url/slug live in the registry for
// AR-4, not in the prompt.)
export type CandidateView = {
  handle: string;
  title: string;
  type: string;
  tier: string;
  difficulty: string;
  durationMin: number;
  summary: string;
  prerequisiteConcepts: string[];
  conceptsTaught: string[];
  requiresPurchase: boolean;
  trustScore: number;
  distance: number | null;
};

export type RetrievalResult = {
  candidates: CandidateView[];
  // Resolve a handle back to the full search row (carries the real id) for AR-4.
  resolve: (handle: string) => SearchResult | undefined;
  steps: number;
  fallbackCalls: number;
  // Free-text the model emitted on its final step — a note on what it gathered.
  notes: string;
};

// Owns the handle registry for one retrieval session.
class RetrievalSession {
  private byId = new Map<string, { handle: string; row: SearchResult }>();
  private byHandle = new Map<string, SearchResult>();
  private counter = 0;

  // Idempotent: the same resource always maps to the same handle within a
  // session, so repeat searches don't multiply candidates.
  register(row: SearchResult): string {
    const existing = this.byId.get(row.id);
    if (existing) return existing.handle;
    const handle = `r${++this.counter}`;
    this.byId.set(row.id, { handle, row });
    this.byHandle.set(handle, row);
    return handle;
  }

  view(row: SearchResult): CandidateView {
    const handle = this.register(row);
    return {
      handle,
      title: row.title,
      type: row.type,
      tier: row.tier,
      difficulty: row.difficulty,
      durationMin: row.durationMin,
      summary: row.summary,
      prerequisiteConcepts: row.prerequisiteConcepts,
      conceptsTaught: row.conceptsTaught,
      requiresPurchase: row.requiresPurchase,
      trustScore: row.trustScore,
      distance: row.distance,
    };
  }

  resolve(handle: string): SearchResult | undefined {
    return this.byHandle.get(handle);
  }

  all(): CandidateView[] {
    return [...this.byHandle.values()].map((row) => this.view(row));
  }
}

function makeTools(session: RetrievalSession, input: CurriculumInput, budget: { fallbacks: number }) {
  return {
    searchResources: tool({
      description:
        'Search the library for pickable resources on the path topic, ranked by semantic ' +
        'relevance to your query. Issue several searches across the distinct sub-skills the ' +
        'path needs. Returns candidates by handle (e.g. "r3").',
      inputSchema: z.object({
        query: z
          .string()
          .describe('What these resources should cover, e.g. "numpy array broadcasting".'),
        difficulty: z
          .enum(['beginner', 'intermediate', 'advanced'])
          .optional()
          .describe('Restrict to this difficulty.'),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      execute: async ({ query, difficulty, limit }) => {
        const rows = await searchResources({
          query,
          topic: input.topic,
          difficulty,
          limit,
          pickableOnly: true,
        });
        return rows.map((r) => session.view(r));
      },
    }),

    getResourceDetails: tool({
      description:
        'Inspect one candidate by its handle: full record plus its container (parent course / ' +
        'playlist) arc and sibling count, to judge cohesion before relying on it.',
      inputSchema: z.object({
        handle: z.string().describe('A handle returned by searchResources, e.g. "r3".'),
      }),
      execute: async ({ handle }) => {
        const row = session.resolve(handle);
        if (!row) return { error: `Unknown handle "${handle}". Use one returned by searchResources.` };
        const full = await prisma.resource.findUnique({
          where: { id: row.id },
          select: {
            url: true,
            parentResourceId: true,
            orderInParent: true,
            parent: { select: { title: true, summary: true, _count: { select: { children: true } } } },
          },
        });
        return {
          handle,
          title: row.title,
          summary: row.summary,
          url: full?.url ?? row.url,
          prerequisiteConcepts: row.prerequisiteConcepts,
          conceptsTaught: row.conceptsTaught,
          partOfContainer: full?.parent
            ? {
                containerTitle: full.parent.title,
                containerSummary: full.parent.summary,
                orderInContainer: full.orderInParent,
                siblingCount: full.parent._count.children,
              }
            : null,
        };
      },
    }),

    triggerWebFallback: tool({
      description:
        'Compound the library by discovering new resources from the web for the path topic. ' +
        'Use only when searches show the library genuinely lacks an area the path needs — it is ' +
        'slow and costly. After it runs, search again to pick up the new resources.',
      inputSchema: z.object({
        reason: z.string().describe('Which area the library is missing that warrants discovery.'),
      }),
      execute: async ({ reason }) => {
        if (budget.fallbacks <= 0) {
          return { error: 'Web-fallback budget for this session is exhausted. Work with the resources already found.' };
        }
        budget.fallbacks -= 1;
        console.log('[curriculum-retrieval] triggerWebFallback', { topic: input.topic, reason });
        const r = await runWebFallback({ topic: input.topic, targetCount: FALLBACK_TARGET_COUNT });
        return {
          insertedCount: r.insertedCount,
          discoveredCount: r.discoveredCount,
          message:
            r.insertedCount > 0
              ? `Added ${r.insertedCount} new resources. Search again to include them.`
              : 'Discovery found nothing new to add.',
        };
      },
    }),
  };
}

const SYSTEM_PROMPT = `You are the retrieval stage of a curriculum agent. Your only job is to GATHER a strong, diverse set of candidate resources for a single-topic learning path. You do NOT select, order, or write the final path — a later stage does that.

How to work:
- Decompose the topic into the distinct sub-skills a learner needs, and run a separate searchResources call for each. Several focused searches beat one broad query.
- Favor coverage: make sure foundational prerequisites AND the more advanced concepts for the target difficulty are represented among the candidates.
- Use getResourceDetails to check a resource's container/cohesion when it matters.
- Only call triggerWebFallback if searches show the library truly lacks an area the path needs; then search again.
- Stop calling tools once the gathered candidates cover the path's arc. Then reply with one or two sentences noting what you gathered and any gaps. Do not list resources or invent ids.`;

function buildPrompt(input: CurriculumInput): string {
  const totalMinutes = input.timeframeWeeks * input.hoursPerWeek * 60;
  return [
    `Topic: ${input.topic}`,
    `Target difficulty: ${input.difficulty}`,
    `Prior knowledge: ${input.priorKnowledge?.trim() ? input.priorKnowledge : '(none stated)'}`,
    `Budget: ${input.timeframeWeeks} weeks × ${input.hoursPerWeek} hrs/week (~${totalMinutes} minutes total)`,
    '',
    'Gather candidate resources that would let a later stage compose this path.',
  ].join('\n');
}

// Deterministic floor: guarantee the loop starts with a non-empty library on a
// cold topic, independent of whether the model later chooses to call fallback.
async function ensureFloor(topic: string): Promise<void> {
  const active = await prisma.resource.count({
    where: { topic, status: 'active', decompositionStatus: 'atomic' },
  });
  if (active < FALLBACK_THRESHOLD) {
    console.log('[curriculum-retrieval] floor fallback', { topic, active, threshold: FALLBACK_THRESHOLD });
    await runWebFallback({ topic, targetCount: FALLBACK_TARGET_COUNT });
  }
}

export async function runRetrieval(input: CurriculumInput): Promise<RetrievalResult> {
  await ensureFloor(input.topic);

  const session = new RetrievalSession();
  const budget = { fallbacks: RETRIEVAL_MAX_FALLBACKS };
  const { model, temperature, maxOutputTokens } = getModel('curriculumRetrieval');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    tools: makeTools(session, input, budget),
    stopWhen: stepCountIs(RETRIEVAL_MAX_STEPS),
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(input),
  });

  const candidates = session.all();
  console.log('[curriculum-retrieval] done', {
    topic: input.topic,
    steps: result.steps.length,
    candidateCount: candidates.length,
    fallbackCalls: RETRIEVAL_MAX_FALLBACKS - budget.fallbacks,
    usage: result.totalUsage,
  });

  return {
    candidates,
    resolve: (handle) => session.resolve(handle),
    steps: result.steps.length,
    fallbackCalls: RETRIEVAL_MAX_FALLBACKS - budget.fallbacks,
    notes: result.text,
  };
}
