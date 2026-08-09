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
  // The requester's completed lessons on this Track: what a carry-over miss would
  // cost them, and the sole trigger for the confirm step.
  completedLessons: z.number(),
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

// Shown only while a Track built without a target mastery is still unedited, and
// deliberately NOT selectable: the wire format's `targetMastery` is a non-nullable
// enum, so "no preference" is a choice the request cannot carry. Offering it as a
// real option either disabled Rebuild with no explanation or was silently ignored.
export const MASTERY_UNSET_LABEL = 'Choose a level';

// R5's precondition 4, mirrored so the refusal is visible before it is spent: an
// unedited form off an unchanged course would be refused as `not_stale`. Lives here
// rather than inline in the dialog because it is the one place the client can drift
// from the service's rule.
export function canSubmitRebuild(status: RebuildStatus, edits: RebuildEdits): boolean {
  if (status.rebuilding || !status.quota.allowed) return false;
  return status.staleness.stale || Object.keys(edits).length > 0;
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

// R6 carries progress over by concept overlap — a lesson carries when enough of
// what it teaches was covered by a lesson you finished. That is a heuristic, so
// the honest sentence is "usually", not "stay". Stated as the ordinary case rather
// than a warning: a rebuilt course being organised differently is the point of
// rebuilding, not a failure.
export const PROGRESS_LINE =
  'Lessons covering material you’ve already finished usually stay marked complete — but a rebuilt course can be organised differently, so some progress may not carry over.';

// The stakes, made concrete, and ONLY when there are stakes: a learner with no
// completed lessons has nothing to lose, and a confirm they cannot fail teaches
// them to click through the one that matters.
export function progressWarning(completedLessons: number): string | null {
  if (completedLessons <= 0) return null;
  return `You’ve completed ${plural(completedLessons, 'lesson', 'lessons')} in this course. Most of that normally carries over, but anything the new course organises differently may not.`;
}

export const CONFIRM_PROMPT = 'Rebuild anyway?';

export function submitLabel(confirming: boolean): string {
  return confirming ? 'Yes, rebuild' : 'Rebuild';
}

// The remainder AFTER the rebuild this sentence describes — `limit - used` is the
// remainder before it, which reads "1 left" on the click that leaves none.
//
// Null once the allowance is gone, because every clause here asserts a rebuild the
// learner can still start ("this uses one of your…"). At the limit that is simply
// false, and it would render directly above FREE_LIMIT_REACHED and a dead button.
export function quotaLine(quota: { used: number; limit: number }): string | null {
  const left = quota.limit - quota.used - 1;
  if (left < 0) return null;
  return `This uses one of your ${quota.limit} rebuilds this month — ${left} left after this.`;
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
