# Track budget-fill — scoped plan

Feature conversation, 2026-07-03. Fixes the 2026-07-02 audit finding that every
generated Track lands far under the learner's requested time budget (prob/stats 115m
of 960m; linear algebra 180m of 1440m; LA refresher 142m of 720m; calculus refresher
384m of 720m). Structure is good; volume is the problem. This is the "composer
budget-sizing" feature the F6–F8 preamble in
[test-runner-and-audit-fixes-plan.md](test-runner-and-audit-fixes-plan.md) deferred
to its own conversation.

## Diagnosis (verified against code + dev DB)

Two distinct root causes, split by topic:

1. **Composer-side (calculus-class paths — supply present, cores too small).** The
   composer prompt calls the budget "informational — do NOT trim for time" and caps
   the mandatory core at "usually 1, up to ~3" (`src/lib/agents/track/composer.ts`).
   The allocator buys depth ONLY from that ranked core (locked 2.5e policy,
   `src/lib/agents/track/allocate.ts`); with 1-item cores a big budget buys nothing.
   The allocator itself needs no change — its per-lesson slices are generous and go
   unused. Calculus has 2,972 candidate minutes against a 720m budget; the gap is
   purely un-emitted core.
2. **Supply-side (prob/stats-class paths).** prob/stats holds 510 candidate minutes
   total against a 960m budget (median 2 candidates/concept, many 4–5m videos) —
   even scheduling *everything* fills 53%. No prompt change can fix this; the
   thickener must source more, and *meatier*, resources. Library-wide, 601 of 683
   resources are ≤30 minutes.

Adjacent defect found while measuring: three >600m resources exist; one (Python
Tutorial, 720m) is correctly `decomposed` (13 children, 0 concept links), but the
MIT OCW Convex Optimization course (1,800m, type=`course`) and the MML book (1,200m,
`book`) escaped decomposition as `atomic` and are attached to concepts (1 + 2
links). A single attached whole-course breaks any fill arithmetic, so containment is
sequenced first.

## Locked decisions for this feature

- **LLM judges, code does arithmetic** — the composer never sees minute math; code
  computes a coarse *depth tier* and the model sizes the complementary core to it.
- **No optional-pool promotion** (2.5e policy stands). The pool is graded as
  *substitutes*; promoting it fills minutes with redundant content. Revisit only if
  Blocks 1+2 measurably under-fill.
- **Uniform fill band, not intent-sensitive.** The budget is the learner's own
  statement; intent shapes *what* fills it, not whether. Target band: **60–110%**
  (+10% end matches `DEFAULT_BUDGET_SLACK`).
- **No headroom reserved for frontier authoring.** The allocator already buys
  breadth at floor cost before depth, so frontier lessons will compete correctly
  when that feature lands; re-check the band then.

## Blocks (one branch each, off `main`, sequential)

### Block 0 — container-resource containment (`fix/container-resource-attachment`, ~150 LOC)

Enforce the existing 2.5b invariant: only atomic units may be attached to concepts.
Parent/container rows stay in the library (the Python Tutorial pattern).

- **Classifier gate** (`src/lib/agents/decomposition/router.ts`): a resource with
  type `course`/`book`, or `durationMin` past a ceiling, never classifies `atomic` —
  route to an existing router where one fits, else `human_review` (unpickable, per
  design).
- **Attachment tripwire**: new `MAX_ATTACHABLE_DURATION_MIN` in `src/lib/config.ts`
  (~300m; discuss exact value in-block), enforced as an admission-time *drop* in
  `selectAttachable` (`src/lib/agents/map/attach-candidates.ts`) — today duration
  only demotes, never drops. Demote in-band, drop past cap.
- **Data cleanup** (one-off driver script): detach the 3 bad ConceptResource links.
  ⚠️ `foundations-of-machine-learning` (spine, python-data-ml) has 3 candidates and
  its teaches-minutes are almost entirely the book — detach must be followed by
  re-sourcing (the `sourceAndAttachConcept` primitive) so readiness doesn't regress.
- Tests: unit for the classifier gate + the attach cap; the cleanup is a
  `scripts/verify-*` driver (live sourcing).

### Block 1 — depth tier + composer core sizing (`feat/budget-depth-tier`, ~200 LOC)

Fixes the composer-side half; measurable immediately on calculus.

- Pure `depthTier(budgetMinutes, includedConceptCount)` → coarse tier
  (`light | standard | deep | immersive`), colocated with the allocator; code
  arithmetic only. Roughly budget-per-concept bucketed; exact thresholds in-block.
- `build-track.ts` computes the tier and passes it to `composeTrack`; the prompt
  replaces "informational — do NOT trim for time" with tier-keyed core-sizing
  guidance ("this budget supports roughly N complementary resources per lesson —
  size each mandatory core accordingly"). Keep: no trimming for time (breadth is
  still the allocator's job), no redundant padding — a deep core spans functions
  (teaches + practice + second perspective), not three near-identical videos.
- Tests: colocated unit for `depthTier`; prompt behavior verified via the live
  `scripts/verify-composer.ts` driver. Manual gate: rebuild the calculus refresher
  (720m) and check fill lands in-band.

### Block 2 — budget-thinness sufficiency axis → thickener (`feat/thin-for-budget-thickener`, ~250 LOC)

Fixes the supply-side half (prob/stats-class paths).

- Composer schema gains `thinForBudget: { conceptSlug, reason }[]` — a SECOND
  sufficiency axis, judged against the depth tier (never minutes): "teachable, but
  the candidate pool can't support this tier". `resourceSufficiency.enough` stays
  teachability-only.
- `build-track.ts` routes `thinForBudget` to `thickenSpine`, **capped** (worst-first,
  max N concepts per build — the thickener is synchronous web sourcing; constant in
  config) and only when a budget is present.
- Thickener sourcing bias: when the trigger is budget-thinness, prefer substantial
  durations (~30–90m band) — the library is 88% ≤30m clips, and
  `MAP_MAX_CANDIDATES_PER_CONCEPT = 6` evicts by score not duration, so six 5-minute
  videos can otherwise permanently block a concept from ever supporting a deep tier.
  Design detail for the block: bias the search/judge vs. a duration-aware eviction.
- Tests: unit for the routing + cap with a stubbed thickener; live end-to-end via a
  driver. Manual gate: rebuild prob/stats (960m) and check fill improves materially.

### Block 3 — fill-ratio telemetry + band + allocator fixtures (`feat/track-fill-telemetry`, ~150 LOC)

- Compute `fillRatio = totalMinutes / budgetMinutes` from the existing
  `AllocationResult` in `build-track.ts`; emit in the structured build log/trace,
  warn outside 60–110%.
- Allocator fixture tests (pure): deep cores + big budget fills ≥ the band floor;
  small budget degrades rank-first as today; outlier-duration primary flagged, not
  silently absorbed (Block 0 makes true outliers unreachable, but the metric should
  stay honest).
- End-to-end band assertions live in the live drivers/telemetry, NOT unit tests
  (fill depends on LLM output + supply).

## Sequencing rationale

Block 0 first: telemetry and fill math are meaningless while one attached resource
can be 2.5× a whole budget, and the cleanup re-sourcing exercises the same thickener
primitive Block 2 extends. Block 1 before Block 2: prompt/code only, no sourcing
cost, and isolates the composer-side gain so Block 2's supply-side gain is
measurable on its own. Re-measure the four audited tracks after each of Blocks 1–2.

## Status

- [ ] Block 0 merged (PR #179)
- [ ] Block 1 merged (PR #180)
- [ ] Block 2 merged (PR #181)
- [ ] Block 3 merged

## Measured results (2026-07-03, live builds on the audited scenarios)

| Scenario | Audit | After Block 1 (sim) | After Blocks 1+2 (real build) |
| --- | --- | --- | --- |
| calculus refresher (720m) | ~53% | 93% | **111%** (marginally over; warn fired) |
| linear algebra (1440m) | 12.5% | 52% | **62%** |
| prob/stats (960m) | 12% | 39% | **63%** |

Notes: real builds include the thicken cycle (prob/stats +14 candidates,
LA +17, calculus +8 — previously zero-candidate frontier concepts now join
their courses, and both LA and calculus recompose to `enough: true` with no
thin flags). Fill is measured on the CLEANED persisted lessons (post
cross-lesson dedup), which is what the learner actually receives — the
allocator's pre-dedup total overstates it (LA: 0.76 vs 0.62).
