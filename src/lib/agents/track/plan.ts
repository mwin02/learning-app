// Phase 2.5e-1 / 2.5e-2b: pure helpers shared by the Track builder. The budget
// trim + depth allocation that used to live here (trimToBudget) moved to
// allocate.ts in 2.5e-7b — the allocator now decides BOTH which lessons survive
// (closure-aware breadth at floor cost) and how many resources each gets (depth).
// What remains here are the two inputs that feed it:
//   - lessonPrereqKeys: the lesson-level prereq map the allocator's closure needs.
//   - budgetMinutesFor: a learner's timeframe → a minute budget.

import type { OrderEdge } from '@/lib/agents/map/order';

// Build the lesson-level prereq map the allocator's closure needs: lesson L depends
// on lesson M when any concept in L has a prerequisite concept that lives in M.
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
// missing (then the allocator keeps the whole composed list). Centralized so the
// route, builder, and allocator agree on the arithmetic.
export function budgetMinutesFor(
  timeframeWeeks: number | null | undefined,
  hoursPerWeek: number | null | undefined,
): number | null {
  if (!timeframeWeeks || !hoursPerWeek) return null;
  return timeframeWeeks * hoursPerWeek * 60;
}
