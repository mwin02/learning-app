// Reports R7: the presentational vocabulary of the rebuild dialog — the wire
// shape of the rebuild status read, the plain-language "what changed since this
// course was built" lines, and the copy for each of R5's refusals. Pure and
// colocated-tested so the dialog component stays markup + state.
//
// The wire schema lives here (not in the client helper) so the counts the copy
// reads and the counts the client parses are one declaration: a staleness term
// R5 stops sending fails parsing here rather than silently rendering as absent.

import { z } from 'zod';
import type { Difficulty } from '@prisma/client';

// Values, not the Prisma enum object: importing an enum's *value* from
// @prisma/client would drag the client runtime into the browser bundle. The
// Record below is what keeps this list honest — a new Difficulty fails the
// build here until it has learner-facing wording.
export const MASTERY_VALUES = ['beginner', 'intermediate', 'advanced'] as const satisfies readonly Difficulty[];

const MASTERY_LABELS: Record<Difficulty, string> = {
  beginner: 'Get the basics',
  intermediate: 'Get properly comfortable',
  advanced: 'Go deep',
};

export function masteryOptions(): { value: Difficulty; label: string }[] {
  return MASTERY_VALUES.map((value) => ({ value, label: MASTERY_LABELS[value] }));
}

export const stalenessSchema = z.object({
  stale: z.boolean(),
  deprecatedResources: z.number(),
  changedResources: z.number(),
  pathChanged: z.boolean(),
  conceptsCreated: z.number(),
  inputsEdited: z.boolean(),
});

export const rebuildStatusSchema = z.object({
  inputs: z.object({
    goal: z.string().nullable(),
    timeframeWeeks: z.number().nullable(),
    hoursPerWeek: z.number().nullable(),
    targetMastery: z.enum(MASTERY_VALUES).nullable(),
  }),
  staleness: stalenessSchema,
  quota: z.object({ allowed: z.boolean(), used: z.number(), limit: z.number() }),
  // Someone is already rebuilding this slot — the dialog says so instead of
  // offering a submit that R5 would refuse with `already_rebuilding`.
  rebuilding: z.boolean(),
});

export type Staleness = z.infer<typeof stalenessSchema>;
export type RebuildStatus = z.infer<typeof rebuildStatusSchema>;
export type RebuildInputs = RebuildStatus['inputs'];

// The dialog's fields as the DOM holds them (strings, blank when unset), and the
// edits that survive comparison with the Track's inputs. Kept here rather than in
// the component: R5 counts only values that DIFFER, so which fields to send is a
// derivation with a right answer, not markup.
export type RebuildFormState = {
  goal: string;
  targetMastery: string;
  timeframeWeeks: string;
  hoursPerWeek: string;
};

export type RebuildEdits = {
  goal?: string | null;
  timeframeWeeks?: number;
  hoursPerWeek?: number;
  targetMastery?: Difficulty;
};

export function formStateFrom(inputs: RebuildInputs): RebuildFormState {
  return {
    goal: inputs.goal ?? '',
    targetMastery: inputs.targetMastery ?? '',
    timeframeWeeks: inputs.timeframeWeeks === null ? '' : String(inputs.timeframeWeeks),
    hoursPerWeek: inputs.hoursPerWeek === null ? '' : String(inputs.hoursPerWeek),
  };
}

function editedNumber(raw: string, current: number | null): number | undefined {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed === current) return undefined;
  return parsed;
}

export function rebuildEdits(inputs: RebuildInputs, form: RebuildFormState): RebuildEdits {
  const edits: RebuildEdits = {};
  const goal = form.goal.trim() === '' ? null : form.goal.trim();
  if (goal !== inputs.goal) edits.goal = goal;
  const weeks = editedNumber(form.timeframeWeeks, inputs.timeframeWeeks);
  if (weeks !== undefined) edits.timeframeWeeks = weeks;
  const hours = editedNumber(form.hoursPerWeek, inputs.hoursPerWeek);
  if (hours !== undefined) edits.hoursPerWeek = hours;
  const mastery = MASTERY_VALUES.find((v) => v === form.targetMastery);
  if (mastery && mastery !== inputs.targetMastery) edits.targetMastery = mastery;
  return edits;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Precondition 4 made legible. `changedResources` and `pathChanged` no longer gate
// a rebuild (see assessStaleness) but are still reported, so both still appear here:
// the corrected-since line is real information alongside a removal, and the weakly
// worded Path line shows up only on a track that is stale for another reason.
//
// The `stale` gate on the first line is the invariant, not an optimisation: the
// dialog decides "is there something to say" and "can you rebuild" from this one
// function, so a not-stale track must produce NO lines. Otherwise a track that moved
// only in the terms the tightening dropped renders a change line next to a disabled
// button — telling the learner something changed and then refusing to act on it.
export function changeSummary(s: Staleness): string[] {
  if (!s.stale) return [];
  const lines: string[] = [];
  if (s.deprecatedResources > 0) {
    lines.push(
      `${plural(s.deprecatedResources, 'resource was', 'resources were')} removed as broken since this course was built.`,
    );
  }
  const corrected = Math.max(0, s.changedResources - s.deprecatedResources);
  if (corrected > 0) {
    lines.push(`${plural(corrected, 'resource has', 'resources have')} been corrected since then.`);
  }
  if (s.conceptsCreated > 0) {
    lines.push(`${plural(s.conceptsCreated, 'new concept', 'new concepts')} appeared in this subject since then.`);
  }
  if (lines.length === 0 && s.pathChanged) {
    lines.push('This subject has been worked on since your course was built.');
  }
  return lines;
}

export const NOTHING_CHANGED =
  'Nothing has changed since this course was built — a rebuild would draw on exactly the same material.';

// The pre-filled form's subtlety: R5 counts only values that actually DIFFER
// from the Track's, so "I touched the form" is not a change.
export const EDIT_HINT =
  'These are what this course was built from. Change at least one — resubmitting the same answers is not a change.';

export const PROGRESS_LINE =
  'Lessons covering material you’ve already finished stay marked complete.';

export function quotaLine(quota: { used: number; limit: number }): string {
  const left = Math.max(0, quota.limit - quota.used);
  return `This uses one of your ${quota.limit} rebuilds this month — ${left} left.`;
}

export function rebuildErrorMessage(code: unknown, limit?: number): string {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'Sign in to rebuild this course.';
    case 'NOT_FOUND':
      return 'This course is no longer part of this program.';
    case 'NOT_ENROLLED':
      return 'You are not enrolled in this program.';
    case 'ALREADY_REBUILDING':
      return 'This course is already being rebuilt — it will appear here when it is done.';
    case 'FREE_LIMIT_REACHED':
      return `You have used all ${limit ?? 'your'} rebuilds this month. They reset at the start of next month.`;
    case 'NOT_STALE':
      return `${NOTHING_CHANGED} Change one of your answers above to ask for a different course.`;
    case 'INVALID_INPUT':
      return 'Check the weeks and hours — they need to be 1–52 and 1–40.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export const ENQUEUED_MESSAGE =
  'Rebuilding — this takes a few minutes. Your new course appears here when it is ready, with your finished lessons carried over.';
