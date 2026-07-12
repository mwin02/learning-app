// Chat intake (Block 2): one conversation turn of the /programs/new intake
// agent. The AR philosophy at small scale — the LLM does conversation +
// extraction (one non-streaming generateObject on Flash, no tools), and
// deterministic code owns correctness: the draft merge (model omissions never
// erase persisted fields), numeric clamping, string caps, and readiness.
//
// Readiness is code, not the model: ready = the merged draft parses against
// generateProgramInputSchema — the exact payload the client will POST to the
// public /api/generate-program route. The model's `done` is a hint only.

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';
import { logWarn, recordUsage, type UsageLike } from '@/lib/log';
import { generateProgramInputSchema } from '@/lib/api/generate-program-schema';
import { buildIntakePrompt, INTAKE_SYSTEM_PROMPT } from './prompt';

export type IntakeMessage = { role: 'user' | 'assistant'; content: string };

// Partial GenerateProgramInput — the server-persisted IntakeSession.draft shape.
export type IntakeDraft = {
  goal?: string;
  background?: string;
  totalHoursPerWeek?: number;
  totalWeeks?: number;
  antiList?: string[];
};

// What the model emits per turn. Every draft field is nullable-required rather
// than optional — Gemini structured output fills nullable fields far more
// reliably than it includes optional ones, and an explicit null cleanly means
// "not gathered yet".
const ExtractionSchema = z.object({
  reply: z.string(),
  draft: z.object({
    goal: z.string().nullable(),
    background: z.string().nullable(),
    totalHoursPerWeek: z.number().nullable(),
    totalWeeks: z.number().nullable(),
    antiList: z.array(z.string()).nullable(),
  }),
  done: z.boolean(),
});

export type IntakeExtraction = z.infer<typeof ExtractionSchema>;

// Clamp bounds mirror generateProgramInputSchema's caps (kept in sync by the
// readiness parse itself: a drifted clamp would just delay `ready`, never
// produce an invalid payload).
const HOURS_MIN = 1;
const HOURS_MAX = 40;
const WEEKS_MIN = 1;
const WEEKS_MAX = 52;
const TEXT_MAX = 2000;
const ANTI_ITEM_MAX = 120;
const ANTI_LIST_MAX = 20;

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

// The deterministic post-pass (pure, exported for tests): merge the model's
// extraction over the persisted draft. Rules:
//   - null / empty-after-trim NEVER erases a persisted value (model omissions
//     lose to server state — the model re-emitting only what changed is fine).
//   - numerics are rounded + clamped into schema range; non-finite is ignored.
//   - strings are trimmed + truncated to the schema cap.
//   - antiList entries are trimmed, empties dropped, each capped, list capped.
//     A literal [] is an explicit RETRACTION and clears the persisted list (the
//     prompt reserves it for "the learner withdrew their exclusions"; null is
//     the no-change signal — without a clear signal, exclusions were a one-way
//     ratchet the chat could never undo). A non-empty list that cleans to
//     nothing is model junk and counts as an omission, not a retraction.
export function mergeDraft(persisted: IntakeDraft, extracted: IntakeExtraction['draft']): IntakeDraft {
  const next: IntakeDraft = { ...persisted };

  const goal = extracted.goal?.trim();
  if (goal) next.goal = goal.slice(0, TEXT_MAX);

  const background = extracted.background?.trim();
  if (background) next.background = background.slice(0, TEXT_MAX);

  if (typeof extracted.totalHoursPerWeek === 'number' && Number.isFinite(extracted.totalHoursPerWeek)) {
    next.totalHoursPerWeek = clampInt(extracted.totalHoursPerWeek, HOURS_MIN, HOURS_MAX);
  }
  if (typeof extracted.totalWeeks === 'number' && Number.isFinite(extracted.totalWeeks)) {
    next.totalWeeks = clampInt(extracted.totalWeeks, WEEKS_MIN, WEEKS_MAX);
  }

  if (extracted.antiList) {
    if (extracted.antiList.length === 0) {
      delete next.antiList;
    } else {
      const cleaned = extracted.antiList
        .map((s) => s.trim().slice(0, ANTI_ITEM_MAX))
        .filter((s) => s.length > 0)
        .slice(0, ANTI_LIST_MAX);
      if (cleaned.length > 0) next.antiList = cleaned;
    }
  }

  return next;
}

// Readiness = the draft IS a valid /api/generate-program payload, verbatim.
export function draftReady(draft: IntakeDraft): boolean {
  return generateProgramInputSchema.safeParse(draft).success;
}

export type IntakeTurnResult = {
  reply: string;
  draft: IntakeDraft;
  ready: boolean;
  done: boolean;
  usage: UsageLike | undefined;
};

// Injectable extraction seam (the goal-gate `classify` pattern) so turn logic
// is drivable without an LLM. Defaults to the real Flash structured call.
export type IntakeExtractor = (prompt: string) => Promise<{
  object: IntakeExtraction;
  usage: UsageLike | undefined;
}>;

// getModel is called lazily HERE (not at module-eval) so importing this module
// stays secret-free for unit tests of the pure parts.
const defaultExtract: IntakeExtractor = async (prompt) => {
  const { model, temperature, maxOutputTokens } = getModel('intake');
  let result: Awaited<ReturnType<typeof generateObject<typeof ExtractionSchema>>> | undefined;
  let lastErr: unknown;
  // Retried once — Gemini structured output occasionally returns unparseable /
  // truncated JSON ('No object generated'); a transient hiccup must not eat one
  // of the session's 15 turns with a 500.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await generateObject({
        model,
        temperature,
        maxOutputTokens,
        schema: ExtractionSchema,
        system: INTAKE_SYSTEM_PROMPT,
        prompt,
      });
      break;
    } catch (err) {
      lastErr = err;
      logWarn('intake.turn-attempt-failed', {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!result) throw lastErr;
  return { object: result.object, usage: result.usage };
};

// One intake turn. `transcript` already ends with the learner's newest message;
// `draft` is the SERVER-persisted draft (never the client's) — the route loads
// it, calls this, and persists the returned draft (plan: server is the draft
// authority).
export async function intakeTurn(
  args: { transcript: IntakeMessage[]; draft: IntakeDraft },
  opts: { extract?: IntakeExtractor } = {},
): Promise<IntakeTurnResult> {
  const extract = opts.extract ?? defaultExtract;
  const prompt = buildIntakePrompt(args);
  const { object, usage } = await extract(prompt);
  recordUsage('intake.turn', usage);
  const draft = mergeDraft(args.draft, object.draft);
  return {
    reply: object.reply,
    draft,
    ready: draftReady(draft),
    done: object.done,
    usage,
  };
}
