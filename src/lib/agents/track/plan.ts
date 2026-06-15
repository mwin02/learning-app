// Phase 2.5e-1: pure budget planner for the Track builder. After the composer
// (2.5e-2) emits an ordered lesson list — spine concepts first, then frontier
// ranked by mastery-relevance — and it has been DAG-validated, this trims the
// list to fit the learner's time budget.
//
// The trim is deterministic and lives in code, not the model (audit 8.3: compute
// budget fit in code; reserve the LLM for judgment). It also enforces the locked
// invariant that a Track is always *spine-complete*: the spine is the required
// backbone, so spine lessons are NEVER dropped — only frontier (opt-in
// enrichment) is trimmed when it overflows the budget. A Track frozen during the
// thin window is alternate-thin, never broken.
//
// Two weakness signals come out of here (the budget axis of "insufficient", which
// thickening cannot fix — see ROADMAP 2.5e two-axis split):
//   - droppedMasteryRelevant: a frontier lesson the composer flagged as relevant
//     to the target mastery had to be dropped for time.
//   - spineOverBudget: the spine alone exceeds the budget (the course can't even
//     fit its backbone in the given time).
// Either makes `budgetWeak` true; the builder records it as a diagnostic and
// still ships the (weaker) Track.

export type PlannableLesson = {
  // Stable key for diagnostics/logging (the builder passes the concept slug join).
  key: string;
  isFrontier: boolean;
  // The composer flagged this frontier lesson as relevant to the target mastery.
  // Only meaningful for frontier lessons; spine lessons are mandatory regardless.
  masteryRelevant: boolean;
  estMinutes: number;
};

export type PlanResult = {
  // Lessons that fit, in the original (composer) order. Spine lessons always
  // survive; frontier survives while the running total stays within budget.
  kept: PlannableLesson[];
  // Frontier lessons trimmed for time, in original order.
  dropped: PlannableLesson[];
  // Sum of kept estMinutes (may exceed budget when the spine alone does).
  totalMinutes: number;
  // Echoes the input budget (null = no timeframe given, so nothing was trimmed).
  budgetMinutes: number | null;
  // A mastery-relevant frontier lesson was dropped (budget-axis weakness).
  droppedMasteryRelevant: boolean;
  // The spine alone exceeds the budget (can't fit the backbone in the time).
  spineOverBudget: boolean;
  // Convenience: either weakness signal — a budget-constrained, weaker Track.
  budgetWeak: boolean;
};

// Trim an ordered lesson list to the budget. `budgetMinutes` null means no time
// constraint (no timeframe/hours supplied) — everything is kept. Spine lessons
// are always kept; frontier lessons are kept greedily in order while the running
// total (spine + accepted frontier) stays within budget, so earlier (higher
// mastery-relevance) frontier wins the budget over later frontier.
export function trimToBudget(
  lessons: PlannableLesson[],
  budgetMinutes: number | null,
): PlanResult {
  const spineMinutes = lessons
    .filter((l) => !l.isFrontier)
    .reduce((sum, l) => sum + l.estMinutes, 0);

  const kept: PlannableLesson[] = [];
  const dropped: PlannableLesson[] = [];
  let running = spineMinutes; // spine is mandatory, so it's already "spent".

  for (const lesson of lessons) {
    if (!lesson.isFrontier) {
      kept.push(lesson);
      continue;
    }
    if (budgetMinutes !== null && running + lesson.estMinutes > budgetMinutes) {
      dropped.push(lesson);
      continue;
    }
    running += lesson.estMinutes;
    kept.push(lesson);
  }

  const totalMinutes = kept.reduce((sum, l) => sum + l.estMinutes, 0);
  const droppedMasteryRelevant = dropped.some((l) => l.masteryRelevant);
  const spineOverBudget = budgetMinutes !== null && spineMinutes > budgetMinutes;

  return {
    kept,
    dropped,
    totalMinutes,
    budgetMinutes,
    droppedMasteryRelevant,
    spineOverBudget,
    budgetWeak: droppedMasteryRelevant || spineOverBudget,
  };
}

// Convert a learner's timeframe to a minute budget, or null when either input is
// missing (then the planner keeps the whole composed list). Centralized so the
// route, builder, and composer agree on the arithmetic.
export function budgetMinutesFor(
  timeframeWeeks: number | null | undefined,
  hoursPerWeek: number | null | undefined,
): number | null {
  if (!timeframeWeeks || !hoursPerWeek) return null;
  return timeframeWeeks * hoursPerWeek * 60;
}
