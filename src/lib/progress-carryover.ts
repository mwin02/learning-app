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
 * The new lesson ids to mark complete, given the old Track's lessons the learner had
 * completed and every lesson of the new Track. Returned in `newLessons` order.
 *
 * A new lesson with no `conceptsTaught` never carries: there is no evidence either
 * way, and inventing some would credit every rebuild's contentless lessons for free.
 */
export function carryOverProgress(
  completedOldLessons: CarryOverLesson[],
  newLessons: CarryOverLesson[],
): string[] {
  const covered = new Set(
    completedOldLessons.flatMap((lesson) => lesson.conceptsTaught.map(normalize)),
  );
  if (covered.size === 0) return [];

  return newLessons
    .filter((lesson) => {
      const concepts = new Set(lesson.conceptsTaught.map(normalize));
      if (concepts.size === 0) return false;
      let hits = 0;
      for (const concept of concepts) if (covered.has(concept)) hits += 1;
      return hits / concepts.size >= CARRY_OVER_MIN_COVERAGE;
    })
    .map((lesson) => lesson.id);
}
