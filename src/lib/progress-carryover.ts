// Reports R6: progress carry-over across a track rebuild.
//
// A rebuild produces a NEW Track with new Lesson rows, so the learner's Progress
// (keyed on lessonId) does not follow the slot repoint on its own — without this,
// pressing "rebuild" silently resets a half-finished course to zero. Lessons are
// matched by what they TEACH (`conceptsTaught`), the only thing stable across two
// independent composes of the same Path.
//
// Pure by construction: no prisma import, so the whole matching rule is unit-testable
// and the DB half (services/carry-over-progress.ts) stays a thin read + insert.

export type CarryOverLesson = {
  id: string;
  conceptsTaught: string[];
};

// A completed old lesson carries WHEN it was completed. Reports F5: the insert used
// to drop this and let Progress.completedAt default to now(), which stamped a whole
// course's history onto the rebuild day of the home heatmap (which reads completedAt
// across every track).
export type CompletedCarryOverLesson = CarryOverLesson & { completedAt: Date };

// `fromLessonId` is the completed old lesson this carry is evidenced by (the one that
// supplied the latest covering concept). Persisted on the carried Progress row so
// completion-EVENT consumers can tell a carry from real work — see Progress.carriedFromLessonId.
export type CarriedLesson = {
  id: string;
  completedAt: Date;
  fromLessonId: string;
};

// Half the new lesson's concepts. The plan's asymmetry decides this number:
// over-crediting costs a learner a skipped review they can redo in one click,
// under-crediting costs them re-doing work they already finished — and that is what
// makes people abandon a course. So the rule leans generous everywhere it can:
//
//   - coverage is measured against the NEW lesson's concept set only (not the union
//     with the old lesson's), so a lesson SPLIT into three narrower ones carries all
//     three rather than none — each new lesson is fully contained in what was done;
//   - the covered set is the union over ALL completed old lessons rather than a
//     best-single-lesson match, so a MERGED lesson whose material the learner
//     finished across two old lessons still carries;
//   - the tie at exactly 0.5 carries (>=, not >), which is the generous side of the
//     one boundary that actually shows up: a two-concept lesson with one concept done.
//
// Below half, the learner has seen less of the lesson than they haven't, and marking
// it complete would hide material they genuinely never covered.
export const CARRY_OVER_MIN_COVERAGE = 0.5;

// Concept slugs are generated per compose pass, so casing/whitespace drift between
// two builds of the same Path is possible and would read as "no overlap".
const normalize = (concept: string) => concept.trim().toLowerCase();

/**
 * The new lessons to mark complete, given the old Track's lessons the learner had
 * completed and every lesson of the new Track. Returned in `newLessons` order.
 *
 * A new lesson with no `conceptsTaught` never carries: there is no evidence either
 * way, and inventing some would credit every rebuild's contentless lessons for free.
 *
 * Each carried lesson's `completedAt` is the LATEST completion among the old lessons
 * that covered it — the moment the learner had actually finished enough of it. Latest
 * rather than earliest because the earlier ones alone did not yet cover the lesson.
 */
export function carryOverProgress(
  completedOldLessons: CompletedCarryOverLesson[],
  newLessons: CarryOverLesson[],
): CarriedLesson[] {
  // concept → the latest completion that taught it.
  const covered = new Map<string, { at: Date; lessonId: string }>();
  for (const lesson of completedOldLessons) {
    for (const concept of lesson.conceptsTaught.map(normalize)) {
      const seen = covered.get(concept);
      if (!seen || lesson.completedAt > seen.at) {
        covered.set(concept, { at: lesson.completedAt, lessonId: lesson.id });
      }
    }
  }
  if (covered.size === 0) return [];

  const carried: CarriedLesson[] = [];
  for (const lesson of newLessons) {
    const concepts = new Set(lesson.conceptsTaught.map(normalize));
    if (concepts.size === 0) continue;
    let hits = 0;
    let latest: { at: Date; lessonId: string } | null = null;
    for (const concept of concepts) {
      const hit = covered.get(concept);
      if (!hit) continue;
      hits += 1;
      if (!latest || hit.at > latest.at) latest = hit;
    }
    if (latest && hits / concepts.size >= CARRY_OVER_MIN_COVERAGE) {
      carried.push({ id: lesson.id, completedAt: latest.at, fromLessonId: latest.lessonId });
    }
  }
  return carried;
}
