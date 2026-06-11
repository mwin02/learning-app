// Phase 2.5e-1 / 2.5e-2b: pure budget planner for the Track builder. After the
// composer (composer.ts) emits an ordered lesson list — spine concepts first,
// then frontier ranked by mastery-relevance — and it has been validated and
// inclusion-closed (validate-composition.ts), this trims the list to fit the
// learner's time budget.
//
// The trim is deterministic and lives in code, not the model (audit 8.3: compute
// budget fit in code; reserve the LLM for judgment). It enforces two invariants:
//
//   1. Spine-completeness: spine lessons are the required backbone and are NEVER
//      dropped — only frontier (opt-in enrichment) is trimmed for time.
//   2. Prerequisite-closure (2.5e-2b): a frontier lesson may be dropped only if
//      NOTHING KEPT depends on it. A frontier concept that is a prerequisite of a
//      spine concept (a frontier→spine edge — possible via manual map edits) or of
//      a kept frontier concept is load-bearing and stays in, even over budget.
//      Dropping a load-bearing prereq would orphan its dependent. The "required"
//      floor is therefore spine + the prereq-closure of spine (which pulls in any
//      forced frontier).
//
// Two budget-axis weakness signals come out of here (the axis thickening cannot
// fix — see ROADMAP 2.5e two-axis split):
//   - droppedMasteryRelevant: a mastery-relevant frontier lesson was dropped.
//   - spineOverBudget: the required floor (spine + forced frontier) alone exceeds
//     the budget.

import type { OrderEdge } from '@/lib/agents/map/order';

export type PlannableLesson = {
  // Stable key for dependency wiring + diagnostics (the builder uses a per-lesson id).
  key: string;
  isFrontier: boolean;
  // The composer flagged this frontier lesson as relevant to the target mastery.
  // Only meaningful for frontier lessons; spine lessons are mandatory regardless.
  masteryRelevant: boolean;
  estMinutes: number;
};

export type PlanResult = {
  // Lessons that fit, in the original (composer) order. Spine + forced-frontier
  // always survive; optional frontier survives while the budget allows.
  kept: PlannableLesson[];
  // Optional frontier lessons trimmed for time, in original order.
  dropped: PlannableLesson[];
  // Sum of kept estMinutes (may exceed budget when the required floor alone does).
  totalMinutes: number;
  // Echoes the input budget (null = no timeframe given, so nothing was trimmed).
  budgetMinutes: number | null;
  // A mastery-relevant frontier lesson was dropped (budget-axis weakness).
  droppedMasteryRelevant: boolean;
  // The required floor (spine + forced frontier prereqs) exceeds the budget.
  spineOverBudget: boolean;
  // Convenience: either weakness signal — a budget-constrained, weaker Track.
  budgetWeak: boolean;
};

// Trim an ordered lesson list to the budget. `budgetMinutes` null means no time
// constraint — everything is kept. `prereqKeys` maps a lesson key to the keys of
// the lessons it directly depends on (build it with `lessonPrereqKeys`); an empty
// map degrades to per-lesson independence (no closure constraint).
//
// Algorithm: start the kept set at the required floor — spine plus its transitive
// prereq closure (so any forced frontier is in). Then walk optional frontier in
// composer order (mastery-relevance); to keep a lesson, keep its whole not-yet-kept
// prereq closure, but only if that closure fits the remaining budget. A lesson
// whose closure doesn't fit is skipped — and anything depending on it will skip too,
// because keeping the dependent would require this lesson's cost. This guarantees
// the kept set stays prerequisite-closed.
export function trimToBudget(
  lessons: PlannableLesson[],
  budgetMinutes: number | null,
  prereqKeys: Map<string, string[]> = new Map(),
): PlanResult {
  const byKey = new Map(lessons.map((l) => [l.key, l]));
  const estOf = (k: string) => byKey.get(k)?.estMinutes ?? 0;

  // Transitive prereq closure of a set of keys (inclusive of the seeds).
  const closure = (seeds: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    const stack = [...seeds];
    while (stack.length > 0) {
      const k = stack.pop()!;
      if (out.has(k)) continue;
      out.add(k);
      for (const p of prereqKeys.get(k) ?? []) if (!out.has(p)) stack.push(p);
    }
    return out;
  };

  // Required floor: every spine lesson + whatever it transitively depends on.
  const spineKeys = lessons.filter((l) => !l.isFrontier).map((l) => l.key);
  const required = closure(spineKeys);
  const requiredMinutes = [...required].reduce((sum, k) => sum + estOf(k), 0);

  const keep = new Set(required);
  let running = requiredMinutes;

  for (const lesson of lessons) {
    if (!lesson.isFrontier || keep.has(lesson.key)) continue;
    // To keep this lesson, keep its not-yet-kept prereq closure as one unit.
    const needed = [...closure([lesson.key])].filter((k) => !keep.has(k));
    const addCost = needed.reduce((sum, k) => sum + estOf(k), 0);
    if (budgetMinutes === null || running + addCost <= budgetMinutes) {
      needed.forEach((k) => keep.add(k));
      running += addCost;
    }
  }

  const kept = lessons.filter((l) => keep.has(l.key));
  const dropped = lessons.filter((l) => !keep.has(l.key));
  const totalMinutes = kept.reduce((sum, l) => sum + l.estMinutes, 0);
  const droppedMasteryRelevant = dropped.some((l) => l.masteryRelevant);
  const spineOverBudget = budgetMinutes !== null && requiredMinutes > budgetMinutes;

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

// Build the lesson-level prereq map `trimToBudget` needs: lesson L depends on
// lesson M when any concept in L has a prerequisite concept that lives in M.
// Edges referencing pruned concepts (which appear in no lesson) drop out — prune
// legitimately breaks a prereq, since the learner already knows it. Self-edges
// (a prereq edge internal to a merged lesson) are ignored.
export function lessonPrereqKeys(
  lessons: { key: string; conceptSlugs: string[] }[],
  edges: OrderEdge[],
): Map<string, string[]> {
  const keyBySlug = new Map<string, string>();
  for (const l of lessons) for (const s of l.conceptSlugs) keyBySlug.set(s, l.key);

  const deps = new Map<string, Set<string>>();
  for (const l of lessons) deps.set(l.key, new Set());
  for (const e of edges) {
    const toKey = keyBySlug.get(e.toSlug);
    const fromKey = keyBySlug.get(e.fromSlug);
    if (!toKey || !fromKey || toKey === fromKey) continue;
    deps.get(toKey)!.add(fromKey);
  }
  return new Map([...deps].map(([k, v]) => [k, [...v]]));
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
