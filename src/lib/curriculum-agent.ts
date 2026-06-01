import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/models';
import { runRetrieval, type CandidateView } from '@/lib/curriculum-retrieval';
import type { Difficulty } from '@prisma/client';

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

// Hybrid curriculum agent (Phase 2.5-AR). Two stages:
//   1. AR-3 `runRetrieval` — an autonomous tool-calling loop gathers candidate
//      resources keyed by opaque handles (r1, r2, …).
//   2. This file (AR-4) — a deterministic, no-tools structured call selects and
//      sequences from those candidates, referencing them by handle.
// Keeping select tool-free sidesteps the confirmed Gemini/Vertex limitation
// that `tools` + `Output.object` in one call yields no structured output
// (see ROADMAP Phase 2.5-AR "Emit mechanism").
//
// The model references candidates by handle, never by cuid. Each returned
// handle is resolved against the retrieval session's registry; an unknown
// handle is a hard error, so the model cannot smuggle in a fabricated id.
const SelectSchema = z.object({
  title: z.string().min(3),
  summary: z.string().min(10),
  items: z
    .array(
      z.object({
        handle: z.string().min(1),
        order: z.number().int().min(1),
        rationale: z.string().min(10),
      }),
    )
    .min(1),
});

export async function generateCurriculum(
  input: CurriculumInput,
): Promise<CurriculumOutput> {
  const { candidates, resolve } = await runRetrieval(input);
  if (candidates.length === 0) {
    throw new CurriculumAgentError(
      `Retrieval gathered no candidates for topic '${input.topic}'. The library is empty and web fallback returned nothing usable.`,
    );
  }

  const totalMinutes = input.timeframeWeeks * input.hoursPerWeek * 60;
  const { model, temperature, maxOutputTokens } = getModel('curriculum');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: SelectSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildSelectPrompt({ input, totalMinutes, candidates }),
  });

  // TODO(observability): replace these console.logs with a real logger
  // (structured logs to Cloud Logging, traces, per-agent token + $ accounting)
  // once we have more than one agent in flight.
  console.log('[curriculum-agent] select', {
    topic: input.topic,
    candidateCount: candidates.length,
    totalMinutes,
    usage: result.usage,
    finishReason: result.finishReason,
  });

  const parsed = result.experimental_output;
  const mapped: CurriculumItem[] = [];
  for (const item of parsed.items) {
    const row = resolve(item.handle);
    if (!row) {
      throw new CurriculumAgentError(
        `Model selected unknown handle "${item.handle}" — not in the retrieved candidate set.`,
      );
    }
    mapped.push({ resourceId: row.id, order: item.order, rationale: item.rationale });
  }
  const sorted = [...mapped].sort((a, b) => a.order - b.order);
  return { title: parsed.title, summary: parsed.summary, items: sorted };
}

const SYSTEM_PROMPT = `You are the selection stage of a curriculum agent. You are given a set of candidate resources (already gathered for this learner) and must compose them into an ordered learning path.

Rules:
- Use ONLY the candidates provided. Reference each chosen resource by its \`handle\` (e.g. "r3") exactly as given. Never invent a handle or transform one.
- You do not have to use every candidate. Select the subset that best forms a coherent path; drop redundant or off-target ones.
- Order resources so prerequisites are taught before they are required by later items. Use each candidate's \`conceptsTaught\` and \`prerequisiteConcepts\` to decide order.
- Skip resources whose teaching is redundant given the learner's stated prior knowledge.
- Total \`durationMin\` of selected items should fit close to but not exceed the learner's time budget.
- Prefer \`tier: "core"\` items. Include \`tier: "optional"\` items only if the budget allows after all needed core items.
- Each item's \`rationale\` must be specific to that resource and to this learner: why it sits in this position, what it adds, who would skip it. No generic filler.
- Target the requested path difficulty. Prefer candidates whose \`difficulty\` matches the target. Use adjacent-difficulty candidates only when no same-level item covers a needed concept, and call that out in the rationale.
- \`title\` is short (max ~70 chars), goal-oriented. \`summary\` is 1–2 sentences describing the path's arc.`;

function buildSelectPrompt(args: {
  input: CurriculumInput;
  totalMinutes: number;
  candidates: CandidateView[];
}): string {
  const { input, totalMinutes, candidates } = args;
  // Drop the retrieval-internal `distance` from the selector's view.
  const list = candidates.map((c) => ({
    handle: c.handle,
    title: c.title,
    type: c.type,
    tier: c.tier,
    difficulty: c.difficulty,
    durationMin: c.durationMin,
    prerequisiteConcepts: c.prerequisiteConcepts,
    conceptsTaught: c.conceptsTaught,
    summary: c.summary,
    requiresPurchase: c.requiresPurchase,
  }));
  return [
    `Topic: ${input.topic}`,
    `Target difficulty: ${input.difficulty}`,
    `Prior knowledge: ${input.priorKnowledge?.trim() ? input.priorKnowledge : '(none stated)'}`,
    `Timeframe: ${input.timeframeWeeks} weeks at ${input.hoursPerWeek} hrs/week (~${totalMinutes} minutes total)`,
    '',
    'Candidate resources:',
    JSON.stringify(list, null, 2),
  ].join('\n');
}
