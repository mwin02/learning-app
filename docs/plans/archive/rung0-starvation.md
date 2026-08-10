# Rung-0 starvation — plan

**Status:** shipped 2026-08-01 · **Blocks:** R0–R3, PRs #295–#300 · **Block IDs:** `R`
(scoped to this plan; see the prefix registry in [../README.md](../README.md))
· **Started:** 2026-07-31

Unblocks free-beta **C2** (`docs/plans/archive/free-beta.md` § C2). The defect below is described in
the past tense from here on — it is what the code did before R1.
**Scope:** one retrieval defect in the sourcing ladder. Deliberately narrow — this is
*not* `docs/plans/library-quality.md`, and neither plan fixes the other's problem.

---

## The defect

`sourceForConcept` (`src/lib/agents/tools/web-fallback.ts:165`) runs a ladder:

```
rung 0  the existing library  (searchNearbyResources, maxDistance 0.48, limit = targetCount)
rung 1  allowlisted fan-out   (YouTube Data API + grounded prong, curated domains)
rung 2  open-web relaxation
```

Rung-0 hits count toward `targetCount`, so the web rungs run only for the shortfall:

```ts
const webTarget = webShortfall(targetCount, libraryCandidateIds.length);  // :186
if (webTarget === 0) { /* skip discovery entirely */ }
```

`REMEDIATION_SOURCE_TARGET_COUNT = 3`. So **any concept with 3 library rows inside
distance 0.48 never reaches web discovery** — regardless of whether those rows teach it.

The header at `web-fallback.ts:174-177` locks this as an accepted tradeoff:

> a concept whose library candidates are mediocre-but-**passing** sees no fresh web
> results until they stop passing.

**The implemented behaviour is not that tradeoff.** The counted rows are *raw search
hits*, not judged survivors. When the judge rejects all 3:

- nothing attaches, so the concept stays a spine hole;
- `libraryRung` (`web-fallback.ts:240-258`) excludes only rows **already attached to the
  concept**, so a rejected row is not excluded — the identical 3 rows come back next pass,
  next run, forever;
- `MAX_REMEDIATION_PASSES = 3` re-derives the same answer three times, then relaxes or
  escalates;
- `--force` bypasses the escalation cool-down but not rung 0, so it changes nothing.

There is no "until they stop passing" exit. The concept is **permanently unfillable** by
any current code path.

## Evidence (measured 2026-07-31, read-only replay of `libraryRung`'s exact parameters)

Every spine hole in every Path examined is rung-0 saturated — **21 of 21**. Not one has
ever reached web discovery.

| Path | DB | holes | saturated |
| --- | --- | --- | --- |
| precalculus | production | 3 | 3 |
| machine-learning | local dev | 2 | 2 |
| physics-mechanics | local dev | 10 | 10 |
| data-structures-algorithms | local dev | 2 | 2 |
| statistics | local dev | 1 | 1 |
| precalculus | local dev | 3 | 3 |

**Re-measured at the R0 gate (2026-07-31/08-01).** Hole counts are a moving snapshot and
three of them had moved by the time R0 shipped; the original numbers above are left as the
measurement that justified the plan, and this is the correction:

| Path | DB | plan says | actually measured at the gate |
| --- | --- | --- | --- |
| statistics | local dev | 1 hole | **0 holes** — commit 7eab38a widened it into the `probability-and-statistics` shelf |
| physics-mechanics | local dev | 10 holes | **6 holes** |
| precalculus | production | 3 holes | **1 hole** |

**The saturation rate held everywhere: 100% of holes examined were rung-0 saturated**
(local `machine-learning` 2/2, local `physics-mechanics` 6/6, production `precalculus`
1/1). Only the counts moved — the finding did not.

The one surviving production `precalculus` hole is the sharpest single data point in this
plan: `function-transformations-and-compositions` is saturated by rows at **d=0.251–0.300**
filed at relevance **0.80/0.90 by the classifier** — "Functions", "Evaluating functions",
"Worked example: evaluating expressions with function notation". Well-filed, well-embedded,
semantically close, and none of them teach transformations or compositions. That is a
different population from the junk samples below (d≈0.4+, relevance 0.00), and it is why no
ingestion-side fix reaches this defect: `library-quality.md` P3/B3 would move neither
those rows nor those distances.

Content samples — none of these teach the concept they were retrieved for:

```
local machine-learning [boosting]              → SVM in 2 minutes · Hyperparameter Tuning · Backpropagation
local machine-learning [k-means-clustering]    → StatQuest PCA · Orange Model Evaluation · SVM in 2 minutes
local physics-mechanics [kinematics-in-1d]     → Work and Kinetic Energy · Kepler's Laws · Center of Mass
prod  precalculus [unit-circle-and-angle-…]    → Area Under Polar Curves · Derivatives of Trig · Parametric Equations
prod  precalculus [polynomial-functions]       → Functions of Several Variables ×2 (exact dup) · Functions
```

Three facts worth carrying:

1. **Thin shelves are more exposed, not less.** `physics-mechanics` has a **10-row** shelf
   and saturates all 10 holes with `relevance: 0.00` rows. The whole topic was built
   without a single web search. Any framing that treats this as a big-borrowed-shelf
   problem (precalculus ← calculus) is wrong: 3 rows inside 0.48 is a low bar.
2. **Exact duplicates consume the budget twice.** `polynomial-functions` spent 2 of its 3
   slots on one resource. That is `library-quality.md` B5's dedupe item with a
   measurable retrieval cost — but deduping does not fix this defect, it only widens the
   junk pool slightly.
3. **Filing quality is not the lever.** Most saturating rows here are `origin: inherited`
   or `relevance: 0.00` classifier filings, so `library-quality.md` P3/B3 would
   change *which* junk rung 0 returns. It would still return 3 rows and still zero the web
   budget. The gate re-measure strengthened this: production `precalculus`'s surviving hole
   saturates on rows the classifier filed at **0.80/0.90** at d=0.251–0.300 — perfect
   filing, still the wrong material.

## Why this blocks C2

C2's deliverable is 12 servable Paths. Today, any spine concept whose shelf holds 3
near-but-wrong neighbours is permanently unfillable, and nothing in the campaign reaches
it — not queue draining, not remediation, not `--force`. **C2 step 2 (adding sources) is
futile while this stands**: a wider allowlist only feeds rungs 1–2, which never run.

## Relationship to `library-quality.md`

Disjoint. P1–P7 are ingestion-side (fields written with no way to say "unknown"). This is
retrieval-side. Neither plan's fixes touch the other's defect. This plan does **not**
pull any of Q1–Q8 forward; that plan's own open question 4 (land Part 1 first, Part 2
gradually, after the beta) stands.

---

# Blocks

Four blocks, `R0` mergeable alone, `R1` the actual fix, `R2` the durability follow-on,
`R3` the close-out. One migration, in R2.

| block | scope | migration | LOC (est.) | status |
| --- | --- | --- | --- | --- |
| R0 | read-only rung-0 coverage diagnostic | no | ~120 | shipped |
| R1 | count judged survivors, not raw hits | no | ~220 | shipped |
| R2 | per-concept rejection memory | **yes** | ~150 | shipped |
| R3 | live verifier + doc reconciliation | no | ~120 | shipped |

## R0 — `scripts/rung0-coverage.ts` (diagnostic, read-only)

The measurement tool. Ships first so R1 has a before/after, and so C2 step 5 can check any
Path for this failure mode without re-deriving the query.

**Deliverable:** `scripts/rung0-coverage.ts <topic...> [--all-concepts]`, mirroring
`libraryRung` exactly — `relatedTopics(topic)`, `REJUDGE_ROUTE_MAX_DISTANCE`,
`limit = REMEDIATION_SOURCE_TARGET_COUNT`, same attached-row exclusion. A divergence here
measures a query the codebase never issues (same discipline as
`scripts/verify-topic-narrowing.ts`, which says so in its header).

Per spine hole it prints `rung0Hits`, the resulting `webShortfall`, a
`WEB DISCOVERY SKIPPED` verdict, and each hit's distance / status / topic memberships.

Costs one query embedding per concept. Writes nothing. Takes the standard
`DATABASE_URL="$SUPABASE_POOLER_URL"` override to run against production
(`docs/operator-tooling.md`).

**Verification:** run against local `machine-learning` and production `precalculus`;
reproduces the table above.

## R1 — count judged survivors, not raw hits

The fix. Restores the tradeoff the header actually locks.

**Change of shape.** Today `sourceAndAttachConcept` sources both rungs, then judges the
combined id set once. It must instead judge rung 0 **before** the web budget is computed:

```
1. libraryRungCandidates()                       → library ids
2. on-ramp backstop (unchanged, prepended)
3. judgeAndAttachCandidates(library ids)         → { attached, primaryAttached }
4. webBudget = webShortfall(targetCount, attached)      ← survivors, not hits
   if (requirePrimary && !primaryAttached) webBudget = Math.max(1, webBudget)
5. if (webBudget > 0) sourceFromWeb({ targetCount: webBudget })
                      → judgeAndAttachCandidates(inserted ids)
6. return the sum
```

**Files:**

- `src/lib/agents/tools/web-fallback.ts` — split `sourceForConcept` into two exported
  entry points, `libraryRungCandidates()` (today's private `libraryRung`) and
  `sourceFromWeb()` (today's `collectSurvivors` + `persistDiscovered` tail). The judge
  cannot move into this module — `source-concept.ts` imports it, so the dependency would
  cycle. Rewrite the ladder comment at `:170-184`: it is the load-bearing doc and it
  currently describes behaviour the code does not have.
- `src/lib/agents/track/source-concept.ts` — the reorder above.
  `judgeAndAttachCandidates` returns `{ attached, primaryAttached }` instead of `number`;
  `primaryAttached` is `hasQualifyingPrimary`'s predicate over `kept`
  (`role === teaches && coverageScore >= MAP_SPINE_MIN_PRIMARY_COVERAGE`), which is the
  exact condition `computeReadiness` uses to decide the hole is closed.
- `src/lib/agents/decomposition/rejudge-sourced-for.ts:93` — sole other caller of
  `judgeAndAttachCandidates`; take `.attached`.
- `scripts/verify-sourcing-ladder.ts`, `scripts/verify-topic-filing-t3.ts` — both call
  `sourceForConcept` directly; repoint at `sourceFromWeb`.

**The `requirePrimary` argument.** Counting *attachments* is not sufficient on its own: 3
rung-0 rows attached as `uses` close nothing, and readiness still calls the concept a
hole. So spine-hole callers pass `requirePrimary: true`, which floors the web budget at 1
when rung 0 attached nothing that qualifies as a primary. Callers:

| caller | `requirePrimary` |
| --- | --- |
| `remediate-path.ts:177` (gap remediation) | **true** — the concept is by definition a hole |
| `ensure-frontier.ts:130`, `add-frontier-concept.ts:136` | **true** — both source only after finding no qualifying primary (`add-frontier-concept.ts:18` says so) |
| `thicken-seam.ts:94` | **false** — the concept already has a primary; forcing a web call every thicken pass is a real cost regression |

**Cost.** Two judge calls per hole where both rungs fire, versus one today. Where the
library genuinely covers the concept, phase 2 is skipped exactly as now — no new spend.
The web rungs' cost is unchanged; they simply become reachable.

**Tests** (`web-fallback.test.ts`, `source-concept` colocated): `webShortfall` is pure and
its existing tests stay valid, but its doc comment inverts. New unit coverage for the
budget derivation — rung 0 attaches 3 → budget 0; attaches 0 → budget 3; attaches 3 as
`uses` with `requirePrimary` → budget ≥ 1; `requirePrimary: false` with 3 attached → 0.

**Verification:** R0 against local `machine-learning` before and after; then
`remediatePath` on that Path and confirm `boosting` / `k-means-clustering` reach rung 1.

## R2 — per-concept rejection memory

R1 fixes the first run. R2 stops a rejected row re-consuming the budget on every later
run — without it, each future remediation still pays a judge call on the same three
useless rows before earning its web budget.

**Schema:** a new `ConceptCandidateRejection { conceptId, resourceId, coverageScore,
judgedAt }`, unique on `(conceptId, resourceId)`, cascading from both parents — same shape
and cascade discipline as `ResourceSourcedFor`. Not folded into `ResourceSourcedFor`:
that table means "sourced for this concept but parked un-attached", which is a different
fact and is consumed by the decompose-time hook.

**Writes:** in `judgeAndAttachCandidates`, for every judged candidate `selectAttachable`
dropped. **Reads:** `libraryRungCandidates` adds them to `excludeIds`.

⚠️ **Migration hygiene (`AGENTS.md`):** the generated `migration.sql` will prepend
`DROP INDEX` for `Resource_embedding_idx` and `RemediationJob_active_per_path`. Delete
both lines and their `-- DropIndex` comments before applying, and leave the standard note
in the file.

**Open question for R2:** should a rejection expire? A resource whose `conceptsTaught` is
later repaired (B1) deserves a re-judge. Cheapest answer: no TTL, and let
`scripts/reclassify-topics.ts` / the B1 repair driver clear rejections for rows they touch.
Decide when R2 is picked up, not now.

## R3 — live verifier + doc reconciliation

**`scripts/verify-rung0-fix.ts`** (shipped): drives a rung-0-saturated concept through
`sourceAndAttachConcept` and asserts web discovery actually ran (rung labels captured from
the `[web-fallback] iteration` lines), that a qualifying primary attached, and that R2
recorded the rejected rung-0 rows. Spends real quota; self-cleaning.

Its fixture is a **throwaway Path/Concept container around a real saturating shelf**. The
subject is auto-selected: it scans real Paths' spine holes, replays `libraryRungCandidates`
(without a `conceptId`, so neither exclusion applies) and takes the first hole whose rung 0
saturates — then runs that topic/slug/title under a fixture Path (`__verify_rung0__`),
never the real one. Inventing a shelf would only prove the judge rejects invented rows; the
defect lives in how genuinely-filed, semantically-close rows meet the real judge. The
fixture container buys the rest: no mutation of a servable Path (`recomputeReadiness`
writes `Path.status`), and a fresh `conceptId` so R2's rejection memory on the *real*
concept can't hide the saturating rows and turn the run green for the wrong reason.

**Docs reconciled** — each had stated the raw-hit behaviour as settled:

- `src/types/resource.ts` (the `precalculus` note in `TOPIC_RELATIONS`) — the starvation it
  describes is reframed as this bug, now fixed; the note's actual argument (keep the edge)
  is untouched.
- `docs/plans/archive/free-beta.md` § C2 — the C1 measurement block, plus a dependency on R1–R2 in
  the block table.
- `docs/plans/library-quality.md` — a "not in this plan" section: this defect is
  retrieval-side, and the production `precalculus` d=0.25/relevance-0.90 case is the
  evidence P3/B3 cannot reach it.
- this file — status, and the gate re-measure of the evidence table.

## Explicitly out of scope

- Any of `library-quality.md` Q1–Q8.
- Tuning `REJUDGE_ROUTE_MAX_DISTANCE` or `REMEDIATION_SOURCE_TARGET_COUNT`. Both are
  tempting and neither is the defect — a tighter ceiling would just move the threshold at
  which starvation begins.
- Re-remediating the affected Paths. That is C2 ops work, and it resumes once R1 lands.

## Rejected alternatives

- **Floor the web budget at ≥1 unconditionally** (one-line). Breaks the locked cost policy
  for every concept, including the ones where the library genuinely covers, and pays a
  discovery call per hole forever. Kept in reserve if R1 proves too invasive mid-beta.
- **Rejection memory alone (R2 without R1).** Leaves every cold build one wasted
  remediation run per hole, and a Path is not servable in the meantime.
- **Exclude low-`relevance` rows from rung 0.** Retrieval-predicate surgery with blast
  radius across every search path, and it fails on the physics case, where the junk is
  filed by the classifier at `relevance: 0.00` and would need a threshold that starves
  thin shelves outright — the failure `review-drain.ts:101` already warns about.
