// Phase 2.75b: the program budget allocator — the pure, deterministic core of the
// plan pass (the analog of the Track allocator's `allocate`). The LLM decomposes a
// goal into topics with an importance/gap WEIGHT + priority tier; this module turns
// those + the program's total budget into each child Track's concrete allocation.
//
// v1 budget model (locked 2026-06-30, "parallel / fixed weeks"): child Tracks build
// in parallel and share one calendar window, so every surviving topic spans the full
// `totalWeeks`, and it is `totalHoursPerWeek` that splits across topics by weight —
// each topic ≥ a floor (PROGRAM_TOPIC_FLOOR_HOURS) so none rounds to zero. The split
// reuses the Track allocator's largest-remainder `allotByWeight` so slices are whole
// hours summing EXACTLY to the budget.
//
// Two deterministic drop stages make "re-run with a tighter budget visibly drops
// nice_to_have / shifts splits" a property of the math, not the LLM:
//   1. maxTopics cap — never plan more than N topics (bounds child fan-out).
//   2. floor feasibility — if Σ floors > totalHoursPerWeek, drop lowest-priority
//      topics (nice_to_have before core, then lowest weight) until the floors fit.
// Survivors are then dense-renumbered 1..M by the LLM's cross-topic order hint.
//
// Pure + deterministic: no IO, no Prisma, no LLM. Fixture-tested in
// scripts/verify-program-budget.ts.

import { PriorityTier } from '@prisma/client';
import { allotByWeight } from '@/lib/agents/track/allocate';
import { MAX_PROGRAM_TOPICS, PROGRAM_TOPIC_FLOOR_HOURS } from '@/lib/config';

// One decomposed, already-gated topic entering the allocator. `key` is the canonical
// topic slug (the orchestrator gates + dedups before calling here); the rest is the
// LLM's per-topic judgment carried through to the persisted ProgramPath / child request.
export type ProgramTopicInput = {
  key: string;
  // Importance/gap weight — higher ⇒ more of the weekly budget. Any positive scale
  // (the split is proportional); non-positive is clamped to 0 (floor-only) so a
  // degenerate weight can't break the largest-remainder math.
  weight: number;
  priorityTier: PriorityTier;
  phaseLabel: string;
  // LLM cross-topic order (teaching/dependency). Ties + gaps are fine — the
  // allocator dense-renumbers survivors; only the relative order is used.
  orderHint: number;
  // One-sentence "why this topic for this goal" — becomes the child request's `goal`
  // (drives intent inference) and the ProgramPath display rationale.
  rationale: string;
};

export type AllocatedProgramTopic = {
  key: string;
  // The child CourseRequest's budget. hoursPerWeek ≥ floor, Σ = totalHoursPerWeek;
  // timeframeWeeks = totalWeeks (parallel / fixed-weeks model).
  hoursPerWeek: number;
  timeframeWeeks: number;
  phaseLabel: string;
  orderInProgram: number; // dense 1..M in cross-topic order
  priorityTier: PriorityTier;
  weight: number;
  rationale: string;
};

export type DroppedProgramTopic = {
  key: string;
  priorityTier: PriorityTier;
  // Why the topic didn't make the plan — which drop stage removed it.
  reason: 'over_max_topics' | 'budget_floor';
};

export type ProgramBudgetResult = {
  topics: AllocatedProgramTopic[];
  dropped: DroppedProgramTopic[];
};

export type AllocateProgramOpts = {
  totalHoursPerWeek: number;
  totalWeeks: number;
  floorHours?: number;
  maxTopics?: number;
};

// Lowest-priority-first comparator for drops: nice_to_have before core, then lowest
// weight, ties broken by the LATER order hint (drop the more-downstream topic first)
// then key for total determinism. Used to pick which topic to shed when we must.
function droppabilityRank(a: ProgramTopicInput, b: ProgramTopicInput): number {
  // core (0) should sort AFTER nice_to_have (1) in "most droppable first" order.
  const tierRank = (t: PriorityTier) => (t === PriorityTier.nice_to_have ? 1 : 0);
  return (
    tierRank(b.priorityTier) - tierRank(a.priorityTier) || // nice_to_have first
    a.weight - b.weight || // then lowest weight
    b.orderHint - a.orderHint || // then the more-downstream topic
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

export function allocateProgramBudget(
  topics: ProgramTopicInput[],
  opts: AllocateProgramOpts,
): ProgramBudgetResult {
  const floor = opts.floorHours ?? PROGRAM_TOPIC_FLOOR_HOURS;
  const maxTopics = opts.maxTopics ?? MAX_PROGRAM_TOPICS;
  const { totalHoursPerWeek, totalWeeks } = opts;

  const dropped: DroppedProgramTopic[] = [];
  // Work on a copy; normalize a non-positive weight to 0 (floor-only share).
  let survivors = topics.map((t) => ({ ...t, weight: t.weight > 0 ? t.weight : 0 }));

  // Stage 1 — maxTopics cap: shed the most-droppable until we're within the cap.
  while (survivors.length > maxTopics) {
    const victim = [...survivors].sort(droppabilityRank)[0];
    survivors = survivors.filter((t) => t !== victim);
    dropped.push({ key: victim.key, priorityTier: victim.priorityTier, reason: 'over_max_topics' });
  }

  // Stage 2 — floor feasibility: each survivor needs ≥ floor h/wk. Drop the most-
  // droppable while Σ floors would overrun the weekly budget. Always keep ≥1 topic
  // (a program with no topics is meaningless); with the default floor=1 and the
  // route's totalHoursPerWeek ≥ 1, at least one topic always fits.
  while (survivors.length > 1 && survivors.length * floor > totalHoursPerWeek) {
    const victim = [...survivors].sort(droppabilityRank)[0];
    survivors = survivors.filter((t) => t !== victim);
    dropped.push({ key: victim.key, priorityTier: victim.priorityTier, reason: 'budget_floor' });
  }

  // Order survivors by the LLM's cross-topic hint (ties by key), then dense-renumber.
  const ordered = [...survivors].sort(
    (a, b) => a.orderHint - b.orderHint || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // Split the ABOVE-floor remainder by weight, then add the floor back to each so
  // every topic clears the floor and the slices still sum to totalHoursPerWeek.
  const remainder = Math.max(0, totalHoursPerWeek - ordered.length * floor);
  const extra = allotByWeight(remainder, ordered.map((t) => t.weight));

  const allocated: AllocatedProgramTopic[] = ordered.map((t, i) => ({
    key: t.key,
    hoursPerWeek: floor + extra[i],
    timeframeWeeks: totalWeeks,
    phaseLabel: t.phaseLabel,
    orderInProgram: i + 1,
    priorityTier: t.priorityTier,
    weight: t.weight,
    rationale: t.rationale,
  }));

  return { topics: allocated, dropped };
}
