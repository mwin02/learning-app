// Phase 2.5e-7a: the Track depth+breadth allocator — Stage 4 of the composer
// pipeline (audit 8.3: the LLM judges, code does the arithmetic). The composer
// (Stages 2–3) emits, per lesson, a coarse `timeWeight` bucket and a ranked
// MANDATORY complementary core (the must-have resources, [0] first) plus an
// OPTIONAL pool. This module turns those + the learner's real minute budget into:
//
//   - BREADTH: which lessons survive — the same closure-aware frontier trim as
//     plan.ts, but costed at each lesson's FLOOR (its first mandatory resource),
//     since depth beyond that is bought from leftover budget. Spine + the prereq-
//     closure of spine is the required floor and is never trimmed; optional frontier
//     competes in MASTERY-RELEVANCE order (the composer's `masteryRelevant` judgment,
//     ties broken by teaching order) while its floor fits — so a tight budget keeps
//     the mastery-critical frontier before the peripheral, as the composer promises.
//   - DEPTH: how many of each kept lesson's mandatory core become PRIMARIES — a
//     heavier `timeWeight` or a bigger budget buys more of the core per concept.
//
// Policy (locked in the 2.5e redesign):
//   - Depth comes ONLY from the ranked mandatory core. The optional pool is never
//     promoted to a primary here — it stays the frozen substitute/invalidation pool
//     (alternates), as before. Higher budget buys core depth, not the pool.
//   - ≥1 guarantee: every kept lesson yields at least one primary (its first
//     mandatory resource), even if that resource alone overflows the lesson's slice.
//   - Mandatory is taken RANK-FIRST: add core[1], core[2], … while they fit the
//     slice; STOP at the first that doesn't (honoring the composer's ranking over a
//     greedy best-fit), and degrade the unfit tail to alternates.
//   - SLACK: both the breadth cap and the per-lesson depth fill tolerate a small
//     overshoot (`slackPct`, default 10%) so a resource is not demoted — nor a whole
//     frontier lesson dropped — for sliding a minute or two past a rounding boundary.
//     Because the slices sum to the budget, allowing each to overshoot by `slackPct`
//     bounds the whole Track to `budget × (1 + slackPct)`.
//
// BREADTH respects an effective `budget × (1 + slackPct)` cap (at floor cost); DEPTH
// distributes the nominal budget by weight as a soft target — the ≥1 guarantee can
// push a low-weight lesson's est over its slice, so the kept total may differ from
// the budget. That is intentional: a must-have resource is never dropped to hit a
// minute target.
//
// Pure + deterministic: no IO, no Prisma, no LLM. The input contract is decoupled
// from both the composer's handles and Prisma rows so it is fixture-testable; the
// builder (2.5e-7b) maps composer output → this contract and persists the result.

// The coarse time-weight buckets, lightest → heaviest. Single source of truth so
// the composer's output enum (composer.ts) can't drift from the allocator's weights.
export const TIME_WEIGHTS = ['low', 'normal', 'high', 'deep'] as const;
export type TimeWeight = (typeof TIME_WEIGHTS)[number];

// Budget-fill Block 1 (docs/track-budget-fill-plan.md): the coarse DEPTH TIER the
// builder computes from the learner's minute budget and hands the composer, so the
// composer can size each lesson's mandatory complementary core to the budget WITHOUT
// doing minute math (the LLM judges which resources complement; code does the
// arithmetic). This is the fix for the audit's under-fill: the composer used to be
// told the budget was "informational" and to keep cores at ~1, so the allocator's
// depth fill — which buys ONLY from the mandatory core — had nothing to buy and
// big-budget Tracks landed at ~12–20% fill.
export const DEPTH_TIERS = ['light', 'standard', 'deep', 'immersive'] as const;
export type DepthTier = (typeof DEPTH_TIERS)[number];

// Budget-per-concept thresholds (minutes) — a tier starts at its threshold. Chosen
// against the audited tracks and the library's duration profile (mostly 5–30m
// resources, so e.g. ~48 min/concept comfortably funds a 2–3 resource core):
//   calculus refresher 720m/22 ≈ 33 → deep; prob/stats 960m/20 = 48 → deep;
//   linear algebra 1440m/21 ≈ 69 → immersive; a 2h skim over 20 concepts → light.
// Computed over the concepts GIVEN to the composer (pre-prune — code can't know the
// composer's own pruning in advance), so thresholds sit slightly low on purpose:
// pruning only raises the true per-concept budget, never lowers it. Tunable.
export const DEPTH_TIER_THRESHOLDS = { standard: 12, deep: 25, immersive: 50 } as const;

// No budget (or a degenerate concept count) → `standard`, the neutral default.
export function depthTier(budgetMinutes: number | null, conceptCount: number): DepthTier {
  if (budgetMinutes === null || conceptCount <= 0) return 'standard';
  const perConcept = budgetMinutes / conceptCount;
  if (perConcept >= DEPTH_TIER_THRESHOLDS.immersive) return 'immersive';
  if (perConcept >= DEPTH_TIER_THRESHOLDS.deep) return 'deep';
  if (perConcept >= DEPTH_TIER_THRESHOLDS.standard) return 'standard';
  return 'light';
}

// Coarse buckets → integer weights (locked decision #6: tune later). A `deep`
// lesson claims 8× the minute-slice of a `low` one.
export const TIME_WEIGHT: Record<TimeWeight, number> = { low: 1, normal: 2, high: 4, deep: 8 };

// Fraction a slice / the budget cap may be overshot before a resource is demoted or
// a frontier lesson dropped — absorbs rounding cliffs; bounds the Track to
// `budget × (1 + slack)`. Tunable per call; the builder (2.5e-7b) passes the default.
export const DEFAULT_BUDGET_SLACK = 0.1;

export type AllocatorCandidate = { resourceId: string; durationMin: number };

export type AllocatorLesson = {
  // Stable key for closure wiring + joining back to the validated lesson (the
  // allocator decides resources + breadth only; titles/concepts live with the caller).
  key: string;
  isFrontier: boolean;
  masteryRelevant: boolean;
  timeWeight: TimeWeight;
  // Ranked mandatory complementary core; [0] is the guaranteed-≥1 primary.
  mandatory: AllocatorCandidate[];
  // The optional substitute pool (kept as alternates; never promoted here).
  optional: AllocatorCandidate[];
};

export type AllocatedLesson = {
  key: string;
  isFrontier: boolean;
  masteryRelevant: boolean;
  // Chosen primaries in rank order — orderInLesson = index + 1. Always ≥1.
  primaries: AllocatorCandidate[];
  // Everything not chosen as a primary: the unfit mandatory tail, then the whole
  // optional pool. The frozen substitute pool for invalidation/promotion.
  alternates: AllocatorCandidate[];
  // How many leading `alternates` are the demoted mandatory-core tail (vs. the
  // optional pool that follows). The track cleanup pass keeps demoted-core but caps
  // the pool — this is the boundary between the two segments of `alternates`.
  demotedCoreCount: number;
  // Sum of primary durations (what the lesson actually costs).
  estMinutes: number;
  // The budget slice this lesson was allotted (null = no budget given).
  sliceMinutes: number | null;
};

export type AllocationResult = {
  // Surviving lessons in input order, each with primaries/alternates resolved.
  kept: AllocatedLesson[];
  // Frontier lessons trimmed for breadth (budget couldn't afford their floor).
  dropped: AllocatorLesson[];
  // Sum of kept estMinutes (may exceed budget when the required floor alone does,
  // or when ≥1 guarantees push low-weight lessons over their slice).
  totalMinutes: number;
  budgetMinutes: number | null;
  // A mastery-relevant frontier lesson was dropped (budget-axis weakness).
  droppedMasteryRelevant: boolean;
  // The required floor (spine + forced-frontier prereqs, at floor cost) exceeds the
  // slack-inflated budget — even the mandatory backbone won't fit the timeframe.
  spineOverBudget: boolean;
  // At least one kept lesson couldn't fit its full mandatory core (tail demoted to
  // alternate). A depth-axis weakness: the budget bought less depth than the
  // composer judged ideal. Distinct from budgetWeak (which is about breadth).
  depthConstrained: boolean;
  // Convenience: a budget-constrained, weaker Track along the breadth axis.
  budgetWeak: boolean;
};

export function allocate(args: {
  lessons: AllocatorLesson[];
  budgetMinutes: number | null;
  // lesson-key → keys it directly depends on (build with plan.ts `lessonPrereqKeys`).
  // Empty map ⇒ per-lesson independence (no closure constraint).
  prereqKeys?: Map<string, string[]>;
  // Overshoot tolerance for the breadth cap + depth fill (default 10%).
  slackPct?: number;
}): AllocationResult {
  const { lessons, budgetMinutes } = args;
  const prereqKeys = args.prereqKeys ?? new Map<string, string[]>();
  const slackPct = args.slackPct ?? DEFAULT_BUDGET_SLACK;
  // Effective breadth cap: the budget plus its slack (null = no budget given).
  const cap = budgetMinutes === null ? null : budgetMinutes * (1 + slackPct);

  // Normalize each lesson into a forced `core` (≥1) + remaining `pool`. The ≥1
  // guarantee promotes optional[0] only when mandatory is empty (degenerate — the
  // composer/validate should always seat a mandatory primary, but never crash).
  const norm = lessons.map((l) => {
    const hasMandatory = l.mandatory.length > 0;
    const core = hasMandatory ? l.mandatory : l.optional.slice(0, 1);
    const pool = hasMandatory ? l.optional : l.optional.slice(1);
    return { l, core, pool, floor: core[0]?.durationMin ?? 0 };
  });
  const byKey = new Map(norm.map((n) => [n.l.key, n]));
  const floorOf = (k: string) => byKey.get(k)?.floor ?? 0;

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

  // --- BREADTH: closure-aware selection at floor cost ----------------------
  const spineKeys = norm.filter((n) => !n.l.isFrontier).map((n) => n.l.key);
  const required = closure(spineKeys);
  const requiredFloor = [...required].reduce((s, k) => s + floorOf(k), 0);

  const keep = new Set(required);
  let running = requiredFloor;
  // Optional frontier competes for the leftover budget in mastery-relevance order
  // (the composer's `masteryRelevant` judgment), ties broken by teaching order — so a
  // tight budget keeps the mastery-critical frontier before the peripheral, honoring
  // the contract the composer prompt states. Closure still pulls in each kept lesson's
  // own frontier prerequisites regardless of their relevance (a load-bearing prereq is
  // never orphaned). With no budget (cap === null) order is moot — everything is kept.
  const frontierByPriority = norm
    .map((n, idx) => ({ n, idx }))
    .filter(({ n }) => n.l.isFrontier && !keep.has(n.l.key))
    .sort((a, b) => Number(b.n.l.masteryRelevant) - Number(a.n.l.masteryRelevant) || a.idx - b.idx);
  for (const { n } of frontierByPriority) {
    if (keep.has(n.l.key)) continue; // already pulled in as another lesson's prereq
    const needed = [...closure([n.l.key])].filter((k) => !keep.has(k));
    const addCost = needed.reduce((s, k) => s + floorOf(k), 0);
    if (cap === null || running + addCost <= cap) {
      needed.forEach((k) => keep.add(k));
      running += addCost;
    }
  }

  const keptNorm = norm.filter((n) => keep.has(n.l.key));
  const dropped = norm.filter((n) => !keep.has(n.l.key)).map((n) => n.l);

  // --- DEPTH: weight-sliced, mandatory-rank-first fill ---------------------
  const slices =
    budgetMinutes === null
      ? keptNorm.map(() => null as number | null)
      : allotByWeight(budgetMinutes, keptNorm.map((n) => TIME_WEIGHT[n.l.timeWeight]));

  let depthConstrained = false;
  const kept: AllocatedLesson[] = keptNorm.map((n, idx) => {
    const slice = slices[idx];
    const primaries: AllocatorCandidate[] = [];
    const alternates: AllocatorCandidate[] = [];
    let used = 0;
    let stopped = false; // once a core item is demoted, the rest of the core is too
    n.core.forEach((cand, j) => {
      if (j === 0) {
        primaries.push(cand); // ≥1 guarantee — taken even if it overflows the slice
        used += cand.durationMin;
        return;
      }
      if (!stopped && (slice === null || used + cand.durationMin <= slice * (1 + slackPct))) {
        primaries.push(cand);
        used += cand.durationMin;
      } else {
        stopped = true;
        alternates.push(cand);
      }
    });
    if (primaries.length < n.core.length) depthConstrained = true;
    // `alternates` so far holds only the demoted mandatory-core tail; record the
    // boundary before appending the optional pool.
    const demotedCoreCount = alternates.length;
    alternates.push(...n.pool);
    return {
      key: n.l.key,
      isFrontier: n.l.isFrontier,
      masteryRelevant: n.l.masteryRelevant,
      primaries,
      alternates,
      demotedCoreCount,
      estMinutes: used,
      sliceMinutes: slice,
    };
  });

  const totalMinutes = kept.reduce((s, l) => s + l.estMinutes, 0);
  const droppedMasteryRelevant = dropped.some((l) => l.masteryRelevant);
  // Measured against the slack-inflated cap: a floor within +slack of the budget is
  // not flagged (slack defines the effective budget).
  const spineOverBudget = cap !== null && requiredFloor > cap;

  return {
    kept,
    dropped,
    totalMinutes,
    budgetMinutes,
    droppedMasteryRelevant,
    spineOverBudget,
    depthConstrained,
    budgetWeak: droppedMasteryRelevant || spineOverBudget,
  };
}

// Split an integer minute `budget` across weighted lessons so the slices are whole
// minutes that sum EXACTLY to the budget (largest-remainder / Hamilton method):
// floor each exact share, then hand the leftover whole minutes to the largest
// fractional remainders (ties broken by index for determinism).
export function allotByWeight(budget: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || budget <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (budget * w) / total);
  const slices = exact.map((x) => Math.floor(x));
  let leftover = budget - slices.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byRemainder.length && leftover > 0; k++, leftover--) {
    slices[byRemainder[k].i] += 1;
  }
  return slices;
}
