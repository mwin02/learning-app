// Reports R3: the presentational vocabulary of the learner-facing report dialog —
// the category picker's plain-language labels, the acknowledgement copy for R2's
// dead-link verdict, and the error copy for the route's failure codes. Pure and
// colocated-tested so the dialog component stays markup + state.
//
// Deliberately no aggregate counts anywhere (locked with the vote toggles: they
// invite herding and are meaningless at beta n).

import type { ReportCategory } from '@prisma/client';
import type { DeadLinkOutcome } from '@/lib/curation/verify-dead-link';

// A Record over the Prisma enum, so adding a ReportCategory fails the build here
// until it has learner-facing wording — the picker can never silently drop one.
const CATEGORY_LABELS: Record<ReportCategory, string> = {
  dead_link: 'Link is broken',
  wrong_topic: 'Wrong topic',
  wrong_lesson_fit: "Doesn't fit this lesson",
  wrong_duration: 'Time estimate is way off',
  wrong_difficulty: 'Too hard or too easy for this lesson',
  paywalled: 'Paywalled or needs a purchase',
  low_quality: 'Poor quality',
  other: 'Something else',
};

// The free-text cap, shared by the route's zod schema and the dialog's textarea so
// the client can't compose a note the boundary will reject.
export const NOTE_MAX_CHARS = 500;

export type ReportCategoryOption = { value: ReportCategory; label: string };

// `generated` rows are the AI-authored on-ramp lessons: they have no external URL,
// so "Link is broken" is meaningless for them and R2 skips the probe anyway. The
// pane knows this from `resource.content != null` (documented in track-view.ts as
// the origin='generated' marker) — no new data plumbing.
export function reportCategoryOptions(opts: { generated: boolean }): ReportCategoryOption[] {
  const entries = Object.entries(CATEGORY_LABELS) as [ReportCategory, string][];
  return entries
    .filter(([value]) => !(opts.generated && value === 'dead_link'))
    .map(([value, label]) => ({ value, label }));
}

// Unlike a vote, a report is acknowledged. The only outcome that acted on its own
// is `confirmed_dead`; `already_deprecated` acted earlier, which is still worth
// saying plainly rather than pretending a review is pending. Everything else is
// genuinely awaiting a human, so it says so.
export function acknowledgementFor(outcome?: DeadLinkOutcome): string {
  if (outcome === 'confirmed_dead') return 'Confirmed broken — removed from future courses.';
  if (outcome === 'already_deprecated') return 'Already removed from future courses — thanks for confirming.';
  return "Thanks — we'll review this.";
}

// The dead-link probe runs synchronously (bounded at 6s), so its pending copy is
// honest about what is happening instead of faking an instant ack.
export function pendingLabelFor(category: ReportCategory): string {
  return category === 'dead_link' ? 'Checking the link…' : 'Sending…';
}

export function reportErrorMessage(code: unknown): string {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'Sign in to report a problem.';
    case 'RATE_LIMITED':
      return 'Too many reports recently — try again in a bit.';
    case 'INVALID_INPUT':
      return 'Please pick a problem and keep the note under 500 characters.';
    case 'NOT_FOUND':
      return 'This resource is no longer available.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
