// Reports R1: the two decisions the report route makes about an incoming report,
// lifted out of the handler so they're testable without HTTP.
//
//   resolveLessonContext — is the claimed placement context real?
//   planReopen           — what does a re-report do to a settled row?

import type { ReportState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logWarn } from '@/lib/log';

// lessonId is best-effort PLACEMENT CONTEXT, not the subject of the report, so a
// context we can't stand behind is dropped rather than refused: the defect is still
// real and worth recording. Two ways it fails to stand up — an id no Lesson has
// (which would otherwise surface as an FK violation, a 500 for a report we could
// keep), and a lesson that never contained this resource. The second matters because
// R4 triages the placement axis (`unlinkFromLesson`) off this field: a fabricated
// pairing points a curator at an unlink unrelated to the report.
export async function resolveLessonContext(
  resourceId: string,
  lessonId: string
): Promise<string | null> {
  const link = await prisma.lessonResource.findUnique({
    where: { lessonId_resourceId: { lessonId, resourceId } },
    select: { lessonId: true },
  });
  if (link) return link.lessonId;

  // Second lookup only on the drop path, and only to say which drop it was: an id
  // no lesson has and a real lesson that never held this resource are different
  // signals to whoever reads the logs.
  const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, select: { id: true } });
  logWarn(lesson ? 'report.unrelated_lesson' : 'report.unknown_lesson', { resourceId, lessonId });
  return null;
}

// No `state`: planReopen reopens unconditionally, so the row's current state is
// never read. Keeping it in the type would imply a branch that doesn't exist.
export type SettledReport = {
  resolution: string | null;
  priorResolution: string | null;
};

export type ReportEvidence = {
  lessonId: string | null;
  note: string | null;
};

export type ReportReopen = {
  state: ReportState;
  resolution: null;
  resolvedAt: null;
  priorResolution?: string | null;
  lessonId?: string;
  note?: string;
};

// Re-reporting REOPENS but never ERASES — neither the learner's evidence nor the
// system's record.
//
// State: a resolved or dismissed report the learner raises again is fresh evidence
// the fix didn't take, so it goes back in front of the operator. `dismissed` reopens
// too — the alternative is a channel that silently swallows a repeat complaint — and
// the unique (user, resource, category) row caps one learner at one reopen per
// dismissal, with the dismissal text preserved for a one-click re-dismiss.
//
// Learner evidence is additive: `lessonId` and `note` are only overwritten when the
// new submission actually supplies one, because a re-report can legitimately carry
// neither. The same complaint raised from the library page has no ambient lesson, and
// an empty note field means "I didn't retype it", not "I retract it".
//
// System record: the settled `resolution` moves to `priorResolution` rather than
// being dropped. Falling back to the existing `priorResolution` when there is nothing
// to move keeps a preserved verdict alive across a second reopen of an already-open
// row, which carries `resolution: null`. A null `existing` is only reachable through
// the upsert's own race, so leave `priorResolution` alone rather than blanking
// whatever landed in between.
export function planReopen(existing: SettledReport | null, evidence: ReportEvidence): ReportReopen {
  return {
    state: 'open',
    resolution: null,
    resolvedAt: null,
    ...(existing ? { priorResolution: existing.resolution ?? existing.priorResolution } : {}),
    ...(evidence.lessonId ? { lessonId: evidence.lessonId } : {}),
    ...(evidence.note ? { note: evidence.note } : {}),
  };
}
