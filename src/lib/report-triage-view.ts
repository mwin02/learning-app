// Reports R4: the presentational layer of the operator triage queue — which
// actions a category offers, and in what order. Sibling to report-view.ts (the
// learner-facing vocabulary), and it REUSES that module's category labels rather
// than restating them: the operator and the learner should be reading the same
// words for the same defect.
//
// Pure and importable from a client component (report-triage.ts pulls in Prisma
// and cannot be).
//
// ⚠️ The load-bearing rule lives here: `wrong_lesson_fit` offers `unlink` and
// deliberately offers NO deprecation. "This doesn't belong in my lesson" is a
// placement defect — the resource may be excellent, just filed against the wrong
// concept — and deprecating on it would destroy a good row on the strength of one
// misplacement. Same reasoning for `wrong_topic` (refile) and the wrong_duration /
// wrong_difficulty / paywalled trio (correct the field, don't throw the resource
// away). Deprecation is offered only where the row itself may be the defect —
// dead_link, paywalled, low_quality — and even then it is never the first option
// unless nothing else can fix it. `other` is free text and offers everything.

import type { ReportCategory } from '@prisma/client';
import { reportCategoryOptions } from '@/lib/report-view';
import type { LessonTarget, TriageAction } from '@/lib/curation/report-triage';

const LABELS = new Map(reportCategoryOptions({ generated: false }).map((o) => [o.value, o.label]));

export function categoryLabel(category: ReportCategory): string {
  return LABELS.get(category) ?? category;
}

// A Record over the Prisma enum, so a new ReportCategory fails the build until
// someone decides which remediation axis it acts on. First entry is the
// recommended action — the UI renders it first and styles it as the primary.
const ACTIONS: Record<ReportCategory, TriageAction[]> = {
  dead_link: ['deprecate_hard', 'deprecate_soft', 'dismiss'],
  wrong_topic: ['refile', 'dismiss'],
  wrong_lesson_fit: ['unlink', 'dismiss'],
  wrong_duration: ['edit', 'dismiss'],
  wrong_difficulty: ['edit', 'dismiss'],
  // `requiresPurchase` is a whitelisted field, so the flag gets corrected first —
  // a wrong boolean is not a reason to throw away a good resource. Deprecation
  // stays available for a row that really is behind a paywall we won't send
  // learners to.
  paywalled: ['edit', 'deprecate_soft', 'dismiss'],
  low_quality: ['deprecate_soft', 'dismiss'],
  other: ['unlink', 'refile', 'edit', 'deprecate_soft', 'deprecate_hard', 'dismiss'],
};

export function actionsForCategory(category: ReportCategory): TriageAction[] {
  return ACTIONS[category];
}

// The operator's `unlink` choices, in the order the picker offers them: which
// reported lesson to act on, and the report that carries it. A target whose
// lesson row is gone (SetNull on a regenerated Track, or a lesson deleted since)
// is kept and labelled — hiding it would leave its reports unreachable, which is
// the group-blocking bug F3c fixes — but `unlink` will refuse it, so it never
// leads.
export type LessonChoice = { reportId: string; lessonId: string | null; label: string };

export function lessonChoices(
  targets: LessonTarget[],
  lessons: { id: string; title: string; trackTitle: string | null }[],
): LessonChoice[] {
  const byId = new Map(lessons.map((l) => [l.id, l]));
  return targets.map((t) => {
    const lesson = t.lessonId === null ? undefined : byId.get(t.lessonId);
    const name = lesson
      ? `${lesson.trackTitle ?? 'track'} → ${lesson.title}`
      : t.lessonId === null
        ? 'no lesson context'
        : `lesson ${t.lessonId} (gone)`;
    const count = t.reports > 1 ? ` · ${t.reports} reports` : '';
    return { reportId: t.reportId, lessonId: t.lessonId, label: `${name}${count}` };
  });
}

export const ACTION_LABELS: Record<TriageAction, string> = {
  deprecate_hard: 'Deprecate (broken)',
  deprecate_soft: 'Deprecate (quality)',
  unlink: 'Unlink from this lesson',
  refile: 'Refile to topic…',
  edit: 'Fix fields…',
  dismiss: 'Dismiss',
};

// Playground chrome (ad-hoc utilities, matching the neighbouring playground
// pages — these predate the centralized token system on purpose).
export const ACTION_CLASSES: Record<TriageAction, string> = {
  deprecate_hard: 'border-red-900 text-red-900 hover:bg-red-50',
  deprecate_soft: 'border-red-600 text-red-700 hover:bg-red-50',
  unlink: 'border-amber-600 text-amber-700 hover:bg-amber-50',
  refile: 'border-blue-600 text-blue-700 hover:bg-blue-50',
  edit: 'border-blue-600 text-blue-700 hover:bg-blue-50',
  dismiss: 'border-gray-400 text-gray-600 hover:bg-gray-50',
};
