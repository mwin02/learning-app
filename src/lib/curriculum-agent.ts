import { Output, generateText } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/models';
import { PENDING_REVIEW_GATE_PER_TOPIC } from '@/lib/config';
import type { Difficulty, Resource } from '@prisma/client';

export type CurriculumInput = {
  topic: string;
  // The desired path difficulty is a user choice, not an agent inference.
  // `priorKnowledge` (free text) and `difficulty` (enum) are different
  // signals: a learner can have intermediate knowledge but want a beginner
  // path to fill gaps. Both feed the prompt.
  difficulty: Difficulty;
  priorKnowledge?: string;
  timeframeWeeks: number;
  hoursPerWeek: number;
};

export type CurriculumItem = {
  resourceId: string;
  order: number;
  rationale: string;
};

export type CurriculumOutput = {
  title: string;
  summary: string;
  items: CurriculumItem[];
};

export class CurriculumAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumAgentError';
  }
}

const ResponseSchema = z.object({
  title: z.string().min(3),
  summary: z.string().min(10),
  items: z
    .array(
      z.object({
        resourceId: z.string().min(1),
        order: z.number().int().min(1),
        rationale: z.string().min(10),
      }),
    )
    .min(1),
});

export async function generateCurriculum(
  input: CurriculumInput,
): Promise<CurriculumOutput> {
  const { topic, difficulty, priorKnowledge, timeframeWeeks, hoursPerWeek } = input;

  const candidates = await loadCandidates(topic);
  if (candidates.length === 0) {
    throw new CurriculumAgentError(
      `No active Resources found for topic '${topic}'. Web fallback lands in Phase 2c.`,
    );
  }

  const totalMinutes = timeframeWeeks * hoursPerWeek * 60;
  const { model, temperature, maxOutputTokens } = getModel('curriculum');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: ResponseSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt({
      topic,
      difficulty,
      priorKnowledge,
      timeframeWeeks,
      hoursPerWeek,
      totalMinutes,
      candidates,
    }),
  });

  // TODO(observability): replace these console.logs with a real logger
  // (structured logs to Cloud Logging, traces, per-agent token + $ accounting)
  // once we have more than one agent in flight. For now console.log is enough
  // to eyeball usage during development and in Vercel function logs.
  console.log('[curriculum-agent] call', {
    topic,
    candidateCount: candidates.length,
    totalMinutes,
    usage: result.usage,
    finishReason: result.finishReason,
  });

  const parsed = result.experimental_output;
  const validIds = new Set(candidates.map((c) => c.id));
  for (const item of parsed.items) {
    if (!validIds.has(item.resourceId)) {
      throw new CurriculumAgentError(
        `Model returned unknown resourceId '${item.resourceId}'.`,
      );
    }
  }
  const sorted = [...parsed.items].sort((a, b) => a.order - b.order);
  return { ...parsed, items: sorted };
}

async function loadCandidates(topic: string): Promise<Resource[]> {
  const active = await prisma.resource.findMany({
    where: { topic, status: 'active' },
  });
  if (active.length >= PENDING_REVIEW_GATE_PER_TOPIC) {
    return active;
  }
  const pending = await prisma.resource.findMany({
    where: { topic, status: 'pending_review' },
  });
  return [...active, ...pending];
}

const SYSTEM_PROMPT = `You are a curriculum agent that sequences learning resources into a path.

Rules:
- Use ONLY the resources provided in the candidate list. Do not invent resources.
- Reference each chosen resource by its exact \`id\`.
- Order resources so prerequisites are taught before they are required by later items. Use each candidate's \`conceptsTaught\` and \`prerequisiteConcepts\` to decide order.
- Skip resources whose teaching is redundant given the learner's stated prior knowledge.
- Total \`durationMin\` of selected items should fit close to but not exceed the learner's time budget.
- Prefer \`tier: "core"\` items. Include \`tier: "optional"\` items only if the budget allows after all needed core items.
- Each item's \`rationale\` must be specific to that resource and to this learner: why it sits in this position, what it adds, who would skip it. No generic filler.
- Target the requested path difficulty. Prefer candidates whose \`difficulty\` matches the target. Use adjacent-difficulty candidates only when no same-level item covers a needed concept, and call that out in the rationale.
- \`title\` is short (max ~70 chars), goal-oriented. \`summary\` is 1–2 sentences describing the path's arc.`;

function buildUserPrompt(args: {
  topic: string;
  difficulty: Difficulty;
  priorKnowledge?: string;
  timeframeWeeks: number;
  hoursPerWeek: number;
  totalMinutes: number;
  candidates: Resource[];
}): string {
  const { topic, difficulty, priorKnowledge, timeframeWeeks, hoursPerWeek, totalMinutes, candidates } = args;
  const learnerCandidates = candidates.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    tier: r.tier,
    difficulty: r.difficulty,
    durationMin: r.durationMin,
    prerequisiteConcepts: r.prerequisiteConcepts,
    conceptsTaught: r.conceptsTaught,
    summary: r.summary,
    requiresPurchase: r.requiresPurchase,
  }));
  return [
    `Topic: ${topic}`,
    `Target difficulty: ${difficulty}`,
    `Prior knowledge: ${priorKnowledge?.trim() ? priorKnowledge : '(none stated)'}`,
    `Timeframe: ${timeframeWeeks} weeks at ${hoursPerWeek} hrs/week (~${totalMinutes} minutes total)`,
    '',
    'Candidate resources:',
    JSON.stringify(learnerCandidates, null, 2),
  ].join('\n');
}
