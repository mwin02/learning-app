import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/models';
import type { CurriculumInput } from '@/lib/curriculum-agent';

// AR-6 self-review. After AR-4 select emits a path, this separate model call
// scores it against an explicit rubric and returns structured findings. It is a
// distinct call (not the generator grading itself in the same context) so the
// verdict is independent of the reasoning that produced the path.
//
// Like the select stage, this is a no-tools `Output.object` call: `tools` +
// `Output.object` in one call yields no structured output on Gemini/Vertex
// (see ROADMAP Phase 2.5-AR "Emit mechanism").
//
// The five criteria mirror the select SYSTEM_PROMPT rules in
// `curriculum-agent.ts` — the critic checks the same contract the selector was
// asked to honor.
const Criterion = z.object({
  pass: z.boolean(),
  note: z.string().min(1),
});

const CritiqueSchema = z.object({
  // Prerequisites are taught before the items that require them.
  prerequisiteOrdering: Criterion,
  // Total durationMin fits close to but does not exceed the time budget.
  budgetFit: Criterion,
  // No whole-course/redundant overlap between selected items.
  noRedundancy: Criterion,
  // Difficulty of items matches the target (adjacent levels only when called out).
  difficultyMatch: Criterion,
  // Every rationale is specific to its resource and this learner, not filler.
  rationaleSpecificity: Criterion,
  // Consolidated, actionable guidance for a revision. When everything passes
  // this can simply note that the path is sound.
  feedback: z.string().min(1),
});

type Critique = z.infer<typeof CritiqueSchema>;

// One ordered, resolved path item handed to the critic. Unlike select (which
// works in opaque handles), the critic sees human-readable metadata so it can
// actually judge ordering, budget, and difficulty.
export type CriticPathItem = {
  order: number;
  title: string;
  type: string;
  tier: string;
  difficulty: string;
  durationMin: number;
  prerequisiteConcepts: string[];
  conceptsTaught: string[];
  rationale: string;
};

export type CritiqueVerdict = Critique & {
  // Overall pass is derived in code (every criterion must pass), not taken from
  // the model — a model could otherwise claim an overall pass while a criterion
  // note flags a real failure.
  pass: boolean;
};

export async function critiqueCurriculum(args: {
  input: CurriculumInput;
  totalMinutes: number;
  title: string;
  summary: string;
  items: CriticPathItem[];
}): Promise<CritiqueVerdict> {
  const { model, temperature, maxOutputTokens } = getModel('curriculumCritic');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: CritiqueSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildCritiquePrompt(args),
  });

  const c = result.experimental_output;
  const pass =
    c.prerequisiteOrdering.pass &&
    c.budgetFit.pass &&
    c.noRedundancy.pass &&
    c.difficultyMatch.pass &&
    c.rationaleSpecificity.pass;

  return { ...c, pass };
}

// Build the revision instruction fed back into AR-4 select after a fail. Leads
// with the consolidated feedback, then enumerates only the criteria that failed
// so the selector knows exactly what to fix.
export function revisionInstruction(verdict: CritiqueVerdict): string {
  const failing: string[] = [];
  if (!verdict.prerequisiteOrdering.pass)
    failing.push(`- Prerequisite ordering: ${verdict.prerequisiteOrdering.note}`);
  if (!verdict.budgetFit.pass)
    failing.push(`- Budget fit: ${verdict.budgetFit.note}`);
  if (!verdict.noRedundancy.pass)
    failing.push(`- Redundancy: ${verdict.noRedundancy.note}`);
  if (!verdict.difficultyMatch.pass)
    failing.push(`- Difficulty match: ${verdict.difficultyMatch.note}`);
  if (!verdict.rationaleSpecificity.pass)
    failing.push(`- Rationale specificity: ${verdict.rationaleSpecificity.note}`);
  return [
    'A reviewer rejected your previous path. Fix these issues in your new selection:',
    verdict.feedback,
    ...failing,
  ].join('\n');
}

const SYSTEM_PROMPT = `You are the review stage of a curriculum agent. You are given a learning path that another stage composed from a candidate set, and the learner's constraints. Score the path against the rubric below and return structured findings.

You are a strict reviewer applying rules, not a co-author. Do not rewrite the path. For each criterion decide pass/fail and write a short, concrete note. If a criterion fails, the note must say exactly what is wrong (name the items, the order, the numbers) so the next stage can fix it.

Judge the path as a whole, the way a reasonable instructor would. Prefer to pass a path that is sound overall; reserve a fail for a concrete, fixable defect — not for theoretical imperfection. When in doubt on a criterion, pass it.

Rubric (each is pass/fail):
- prerequisiteOrdering: Fail ONLY for a true ordering inversion inside the path — an item depends on a concept that a LATER item teaches. Foundational background that the candidate set does not teach (e.g. basic statistics for an introductory ML resource) does NOT fail this criterion when a learner at the target difficulty, or with the stated prior knowledge, could reasonably already have it or pick it up alongside. Do not fail merely because a supporting concept isn't explicitly taught by another item.
- budgetFit: The sum of durationMin should not exceed the learner's total time budget, and should not underfill so badly the time is largely wasted. Treat anywhere from roughly half the budget up to the full budget as a pass; fail only on a clear overrun or a drastic underfill.
- noRedundancy: Fail ONLY when two items substantially duplicate the same material so that one is largely wasted, or when a single item is a self-contained course that makes the others redundant. Partial overlap, a brief recap, or complementary coverage of a shared topic from different angles is acceptable and should pass.
- difficultyMatch: Item difficulty matches the target. Adjacent-difficulty items are acceptable when the item's rationale justifies it, or when no same-level candidate covers a needed concept. Fail only on an unexplained, jarring mismatch.
- rationaleSpecificity: Every rationale is specific to that resource and this learner (why here, what it adds, who skips it). Fail only if a rationale is generic filler that could apply to any resource.

Then write 'feedback': one short paragraph of actionable guidance for a revision. If everything passes, state plainly that the path is sound.`;

function buildCritiquePrompt(args: {
  input: CurriculumInput;
  totalMinutes: number;
  title: string;
  summary: string;
  items: CriticPathItem[];
}): string {
  const { input, totalMinutes, title, summary, items } = args;
  const sumDuration = items.reduce((acc, it) => acc + it.durationMin, 0);
  const ordered = [...items].sort((a, b) => a.order - b.order);
  return [
    `Topic: ${input.topic}`,
    `Target difficulty: ${input.difficulty}`,
    `Prior knowledge: ${input.priorKnowledge?.trim() ? input.priorKnowledge : '(none stated)'}`,
    `Timeframe: ${input.timeframeWeeks} weeks at ${input.hoursPerWeek} hrs/week (budget ~${totalMinutes} minutes)`,
    `Path total: ${sumDuration} minutes across ${ordered.length} items`,
    '',
    `Path title: ${title}`,
    `Path summary: ${summary}`,
    '',
    'Ordered path items:',
    JSON.stringify(ordered, null, 2),
  ].join('\n');
}
