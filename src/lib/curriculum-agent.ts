import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/models';
import { runRetrieval, type CandidateView } from '@/lib/curriculum-retrieval';
import {
  critiqueCurriculum,
  revisionInstruction,
  type CriticPathItem,
  type CritiqueVerdict,
} from '@/lib/curriculum-critic';
import { CRITIC_MAX_REVISIONS } from '@/lib/config';
import type { OnTrace } from '@/lib/agent-trace';
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

// Hybrid curriculum agent (Phase 2.5-AR). Three stages:
//   1. AR-3 `runRetrieval` — an autonomous tool-calling loop gathers candidate
//      resources keyed by opaque handles (r1, r2, …).
//   2. AR-4 select — a deterministic, no-tools structured call selects and
//      sequences from those candidates, referencing them by handle.
//   3. AR-6 critic + revise — a separate model call scores the emitted path
//      against a rubric (`curriculum-critic.ts`); on a fail verdict, select is
//      re-run with the critic's feedback, bounded by CRITIC_MAX_REVISIONS.
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
  opts: { onTrace?: OnTrace } = {},
): Promise<CurriculumOutput> {
  const onTrace: OnTrace = opts.onTrace ?? (() => {});

  const { candidates, resolve } = await runRetrieval(input, { onTrace });
  if (candidates.length === 0) {
    throw new CurriculumAgentError(
      `Retrieval gathered no candidates for topic '${input.topic}'. The library is empty and web fallback returned nothing usable.`,
    );
  }

  const totalMinutes = input.timeframeWeeks * input.hoursPerWeek * 60;

  // select → critique → (maybe revise). The first pass has no feedback; each
  // subsequent pass feeds the critic's findings back into select. We keep the
  // last produced path as the best-effort result if the critic still fails
  // after the final allowed revision.
  let output: CurriculumOutput | null = null;
  let feedback: string | undefined;

  for (let revision = 0; revision <= CRITIC_MAX_REVISIONS; revision++) {
    const selected = await runSelect({
      input,
      totalMinutes,
      candidates,
      resolve,
      feedback,
      revision,
      onTrace,
    });
    output = selected.output;

    onTrace({ kind: 'stage', label: 'critique started', detail: { revision } });
    const verdict = await critiqueCurriculum({
      input,
      totalMinutes,
      title: selected.output.title,
      summary: selected.output.summary,
      items: selected.criticItems,
    });

    logVerdict(input, revision, verdict);
    onTrace({
      kind: 'stage',
      label: verdict.pass ? 'critique passed' : 'critique failed',
      detail: {
        revision,
        pass: verdict.pass,
        criteria: {
          prerequisiteOrdering: verdict.prerequisiteOrdering.pass,
          budgetFit: verdict.budgetFit.pass,
          noRedundancy: verdict.noRedundancy.pass,
          difficultyMatch: verdict.difficultyMatch.pass,
          rationaleSpecificity: verdict.rationaleSpecificity.pass,
        },
        feedback: verdict.feedback,
      },
    });

    if (verdict.pass) return selected.output;
    feedback = revisionInstruction(verdict);
    if (revision < CRITIC_MAX_REVISIONS) {
      onTrace({
        kind: 'stage',
        label: 'revision requested',
        detail: { nextRevision: revision + 1, feedback },
      });
    }
  }

  // Exhausted the revision budget without a pass. Return the best-effort path
  // rather than failing the request; the contract guarantees a CurriculumOutput.
  console.log('[curriculum-agent] critic budget exhausted', {
    topic: input.topic,
    revisions: CRITIC_MAX_REVISIONS,
  });
  onTrace({
    kind: 'info',
    label: 'critic budget exhausted',
    detail: { revisions: CRITIC_MAX_REVISIONS },
  });
  // `output` is always set: the loop runs at least once (revision 0).
  return output as CurriculumOutput;
}

// One AR-4 select pass. Returns both the customer-facing CurriculumOutput (ids
// resolved from handles) and the human-readable items the critic scores.
async function runSelect(args: {
  input: CurriculumInput;
  totalMinutes: number;
  candidates: CandidateView[];
  resolve: (handle: string) => { id: string } | undefined;
  feedback: string | undefined;
  revision: number;
  onTrace: OnTrace;
}): Promise<{ output: CurriculumOutput; criticItems: CriticPathItem[] }> {
  const { input, totalMinutes, candidates, resolve, feedback, revision, onTrace } = args;
  const byHandle = new Map(candidates.map((c) => [c.handle, c]));
  const { model, temperature, maxOutputTokens } = getModel('curriculum');
  onTrace({
    kind: 'stage',
    label: 'select started',
    detail: { revision, candidates: candidates.length, revised: revision > 0 },
  });

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: SelectSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildSelectPrompt({ input, totalMinutes, candidates, feedback }),
  });

  // TODO(observability): replace these console.logs with a real logger
  // (structured logs to Cloud Logging, traces, per-agent token + $ accounting)
  // once we have more than one agent in flight.
  console.log('[curriculum-agent] select', {
    topic: input.topic,
    revision,
    candidateCount: candidates.length,
    totalMinutes,
    usage: result.usage,
    finishReason: result.finishReason,
  });

  const parsed = result.experimental_output;
  const mapped: CurriculumItem[] = [];
  const criticItems: CriticPathItem[] = [];
  for (const item of parsed.items) {
    const row = resolve(item.handle);
    if (!row) {
      throw new CurriculumAgentError(
        `Model selected unknown handle "${item.handle}" — not in the retrieved candidate set.`,
      );
    }
    mapped.push({ resourceId: row.id, order: item.order, rationale: item.rationale });
    // The candidate view always has this handle: `resolve` succeeded above and
    // both maps are built from the same retrieval session.
    const view = byHandle.get(item.handle)!;
    criticItems.push({
      order: item.order,
      title: view.title,
      type: view.type,
      tier: view.tier,
      difficulty: view.difficulty,
      durationMin: view.durationMin,
      prerequisiteConcepts: view.prerequisiteConcepts,
      conceptsTaught: view.conceptsTaught,
      rationale: item.rationale,
    });
  }
  const sorted = [...mapped].sort((a, b) => a.order - b.order);
  onTrace({
    kind: 'stage',
    label: 'select done',
    detail: {
      revision,
      selected: sorted.length,
      title: parsed.title,
      totalTokens: result.usage?.totalTokens,
    },
  });
  return {
    output: { title: parsed.title, summary: parsed.summary, items: sorted },
    criticItems,
  };
}

function logVerdict(
  input: CurriculumInput,
  revision: number,
  verdict: CritiqueVerdict,
): void {
  console.log('[curriculum-agent] critic', {
    topic: input.topic,
    revision,
    pass: verdict.pass,
    criteria: {
      prerequisiteOrdering: verdict.prerequisiteOrdering.pass,
      budgetFit: verdict.budgetFit.pass,
      noRedundancy: verdict.noRedundancy.pass,
      difficultyMatch: verdict.difficultyMatch.pass,
      rationaleSpecificity: verdict.rationaleSpecificity.pass,
    },
    feedback: verdict.feedback,
  });
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
  feedback?: string;
}): string {
  const { input, totalMinutes, candidates, feedback } = args;
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
  const lines = [
    `Topic: ${input.topic}`,
    `Target difficulty: ${input.difficulty}`,
    `Prior knowledge: ${input.priorKnowledge?.trim() ? input.priorKnowledge : '(none stated)'}`,
    `Timeframe: ${input.timeframeWeeks} weeks at ${input.hoursPerWeek} hrs/week (~${totalMinutes} minutes total)`,
    '',
    'Candidate resources:',
    JSON.stringify(list, null, 2),
  ];
  if (feedback?.trim()) {
    lines.push('', feedback.trim());
  }
  return lines.join('\n');
}
