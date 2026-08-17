# Resource serveability — enforce the library standard

**Status:** active · **Blocks:** S1–S9; no PRs yet · **Block IDs:** `S` · **Started:** 2026-08-17

Implements items 2–5 of the serveability work. Item 1 is done and is **not** in this plan:
the standard is locked at `resource-standard.md`, deliberately free of examples, counts and
mechanics. Nothing here may restate or reinterpret it. When a brief below and the standard
disagree, the standard wins and the brief is a bug.

Companion to `library-quality.md`, which fixed fields written with no way to say "unknown".
This plan fixes a different defect on the same pipeline: **rows admitted that should never
have been rows at all**, and **rows whose stored description is no longer true.**

> ⚠️ **Precondition: PR #348 must merge before S1 starts.** S1 moves `urlKind` out of
> `src/lib/curation/khan-probe-duration.ts`, which does not exist on `main` — it lands in
> the Khan duration backfill (`49a0015`, PR #348, base `main`). Starting S1 off `main` gives
> it nothing to move; starting it off #348's branch stacks this plan's entire chain behind a
> PR it has no other reason to depend on. Verified 2026-08-17.

---

## The diagnosis

### Part A — the library has no concept of serveability

Three gaps, each independently sufficient to admit a resource nobody should be sent to:

**1. Only one of two ingestion seams is guarded, and it is the narrower one.**
`classifyNonTeaching` runs in `createChild` (`upsert-resource.ts:601`) — decomposition
children only. A web-discovery **root** is created 350 lines earlier
(`upsert-resource.ts:224-254`) with `status: 'pending_review'` and no content check of any
kind. Discovery is the pipeline that reaches the open web, so the least-trusted admission
path is the unguarded one.

**2. The guard that does exist answers a different question.** `classifyNonTeaching` asks
"is this page *furniture*". It has no rule for a page that teaches nothing because the
learner is meant to *do* it, and none for a page that only makes sense after its sibling —
the standard's clauses 5 and 4. Nothing in the codebase implements either.

**3. Review is the only gate that can see a page, and its rubric predates both clauses.**
A reviewer following the rubric exactly would approve an exercise page and a chain page,
because neither is a rubric violation today.

### Part B — nothing checks whether a row's description is still true

The standard's clause 6 (**accurately described**) has **zero** implementing rules anywhere
in the codebase. The Khan duration backfill found four distinct ways a row lies about
itself, and each one is invisible to every existing check:

| Defect | Evidence found | Cheapest detector |
| --- | --- | --- |
| Stored URL now serves a different content kind | 7 rows typed `article` whose URLs serve `/v/`, `/pt/`, or a bare unit page | `urlKind(stored)` vs `urlKind(probe.url)` |
| The page's own declared kind contradicts the stored type | a row typed `interactive` that Khan serves as an article | `probe.pageKind` vs `type` |
| Stored `type` contradicts the stored URL's own kind | 8 rows, 3 pickable, 1 attached — a `/a/` URL not typed `article` or a `/v/` URL not typed `video` | `urlKind(stored)` vs `type` — **free, no I/O** |
| The URL serves content its slug does not name, with no redirect | found only by an agent noticing a title that did not match | stored `title` vs `probe.title` — noisy, so a flag, never a verdict |
| The body is a shell around an embedded widget | `"Make a spinoff here!"` — 4 words of article where `main` reads 1,126 | `mainWords / articleWords` ratio |

**Why this half matters more than its row count suggests.** Three of these five defects are
repaired by *correcting the type*, not by exclusion. Without a re-type path, a blanket
`type='interactive'` exclusion **deprecates a good lesson** whose only fault is a stale
label — inverting the standard's own one-sided error budget. And there is no re-type path:
`ResourceUpdateFields` whitelists five fields and `type` is not one of them
(`update-resource.ts:34-43`).

### What this has produced

Counted on production 2026-08-17 (2,309 rows; 2,011 pickable = `active` + `atomic`; 702
attached to ≥1 concept). Format **all / pickable / pickable-and-attached**:

| Population | Clause | Count |
| --- | --- | --- |
| `type = 'interactive'` | 5 | 61 / 48 / 12 |
| Khan `/pi/` (coding challenge) | 5 | 19 / 19 / 0 |
| Khan `/pt/` (talkthrough + challenge) | 5 | 14 / 11 / 10 |
| Khan `/e/` (exercise) | 5 | **0 / 0 / 0** |
| Khan URL with no content-kind segment | 3 | 42 / 1 / 1 |
| chain pages (`/cryptochallenge/`) | 4 | 8 / 6 / 0 |
| slug begins `practice-` | 5 | 2 / 2 / 0 |
| prose under 400 words **with** ≥1 exercise widget | 5 | 44 of 138 probed |
| stored `type` vs stored URL kind mismatch | 6 | 8 / 3 / 1 |
| stored URL redirects across content kinds | 6 | 7 probed |

**The two findings that shaped the block structure:**

**Khan `/e/` exercise pages are not the problem — there are none.** The library's exercise
problem arrives disguised: both rows that motivated this work are ordinary `/a/` URLs typed
`article`. No rule over `type` or `url` can see either. That is why the classifier comes in
two halves and why the page-level half cannot run at ingestion.

**The exclusion is cheap, and almost all of its cost is repairable.** Of the 12 attached
`interactive` rows, **10 are the Khan `/pt/` rows** — the same rows counted twice by two
rules. Each is a 2–6 minute teaching video followed by an in-browser challenge, so
repointing at the video keeps the lesson. That leaves **2 attached rows** (one MIT Open
Learning Library, one visualgo) that genuinely leave a hole for remediation to refill.

---

## Locked decisions (this plan)

| Decision | Why |
| --- | --- |
| The classifier splits by **clause**, not by evidence type: serveability (3/4/5) and metadata integrity (6) are separate modules | They answer different questions and have opposite remedies — exclusion vs. correction. A single module returning both would let a caller act on the wrong one. |
| Serveability itself splits **row-level** (`type` + `url`, no I/O) and **probe-level** | Forced by the diagnosis: ingestion has no page, review has nothing else. One function with an optional probe argument would let a caller with no probe silently receive a weaker verdict. |
| Row-level serveability is wired into **both** ingestion seams, root and child | Fixing only `createChild` leaves the open-web path unguarded — gap 1. |
| **Clause 6 is NOT enforced at ingestion.** Detection only, feeding review and the backfill | At ingestion `type` comes from the LLM extraction, so a mismatch means "the extraction is wrong", and the right response is to fix the field — a repair loop that does not belong in a create path. Detection at review, where a human sees the page, is where a correction can be trusted. |
| A non-serveable row is still **created**, then soft-deprecated | Verbatim the furniture precedent (`upsert-resource.ts:594-600`): skipping the insert loses the URL and the next decomposition re-admits it with nothing for the canonical-URL dedup to collapse onto. |
| **A clause-6 repair outranks a clause-5 exclusion.** A row whose page contradicts its stored type is re-typed, never deprecated on the stale type | Without this precedence the removal sweep destroys exactly the rows the Khan backfill identified as mislabelled-but-good. This is the standard's error budget applied to the sweep. |
| `type` becomes editable, **only on `atomic` rows** — this constraint is the safety argument and is sufficient alone | `resource-update-schema.ts:12-13` excludes `type` because "a type flip changes router classification". **That reason does not survive reading the router.** `CONTAINER_TYPES` is documented as "a candidate signal, not a verdict — the doc-TOC router fetches the page and decides" (`router.ts:41-47`), so type never determines containment; it only decides whether the page is examined. What makes the edit safe is that an `atomic` row is **already** in the never-examined state, so retyping it there is not a regression. Precedent: `retype-ocw-sessions.ts` did `book → article` on 32 atomic rows. |
| The permitted targets are `article` and `video`. **This is scope, not safety** | ⚠️ Do not justify it via the router: `classify()` returns `{kind:'atomic'}` for a non-container type *without fetching* (`router.ts:106-108`), so retyping **to** `article` is the direction that skips examination — the restriction permits it rather than preventing it. It is kept because those are the only targets clause 6 needs, and a container-type target interacts with the `book` duration floor and whole-work containment, where `action: 'decompose'` is the right tool. |
| S6 and S7 must document the **re-decompose interaction** | A row retyped to `article` short-circuits a *later* `action: 'decompose'`: that route calls `decompose()` (`decomposition-review/route.ts:141`) → `classify()` (`decompose.ts:137`), which routes an `article` to atomic without scraping. The mitigation is the route's existing `force` bypass. This is the real content of the original exclusion and it is a documentation duty, not a code constraint. |
| Every removal goes through `applyPendingReview({ action: 'reject', severity: 'soft' })` | It is the only seam that also drops `ConceptResource` links and recomputes Path readiness (`pending-review.ts:224-250`). A driver writing `status` directly would leave 12 rows deprecated, invisible to retrieval, and still placed in live concept maps. `deprecate-furniture.ts:128` establishes this. |
| `severity: 'soft'`, never `hard` | `hard` means broken. A serveability failure is a working page we choose not to serve. |
| The `ResourceType.interactive` enum value **stays** | It is the label the exclusion is written against; removing it needs a migration and leaves the excluded rows unnameable. |
| Page-level measurement is **Khan-only** this pass | The existing probe is Khan-shaped: `.perseus-article` is its content selector (`khan-probe.js:78`). A host-agnostic probe is a separate feature. |
| The measurement driver reads the **existing** probe artifacts | 526 Khan rows were already probed for the duration backfill; re-probing to answer a second question is a browser pass nobody needs to pay twice. |
| The review skill's rubric is **extended, not rewritten** | Its container-sampling, exposed-index and approve-root-last machinery is load-bearing and hard-won. |
| `urlKind` **moves** into the serveability module; `khan-probe-duration.ts` imports it back | One decision, one place. Gated on the precondition above. |
| **Deviation from `CLAUDE.md`: S5 ships no unit test.** | The convention is that new *pure logic* gets a colocated test, and S5 contains none — it is a reporting driver over uncommitted local artifacts, and all logic it calls is tested in S1/S3/S4. Same footing as `report-unmeasured.ts` and `measure-unknown-durations.ts`. S8 and S9 do write, and both carry integration tests. |

### Rejected alternatives

| Rejected | Why |
| --- | --- |
| **A words-per-widget ratio to detect practice pages.** | Measured over 138 probed article rows; it does not separate. `Calculating the mean` is 492 words around 31 widgets and is a real lesson; `Mean as the balancing point` is 741 words and 36 widgets. Any threshold catching the practice pages also catches those. The prose floor **paired with** a widget count does separate, and it reuses a constant already in the codebase rather than one invented here. |
| **Excluding all Khan "… review" articles.** 33 / 27 / 7 rows. | They are summary-plus-practice pages that teach in prose. Excluding them fails the standard's ambiguity rule — a weak signal deciding alone — and would be the plan's largest false-positive population. |
| **Treating the title mismatch (defect 4) as a verdict.** | Khan appends `(article) | Khan Academy` to every title, and legitimate re-titling exists. It flags for human review and never deprecates on its own — the two-signal construction `non-teaching.ts:207-210` already uses. |
| **Adding `type` to the whitelist unrestricted.** | Would silently overturn a documented decision and permit `article → book`, which changes what the router would do with the row. The atomic-plus-two-targets narrowing gets the repair without touching the reason the exclusion existed. |
| **Deleting non-serveable rows.** | A `Resource` is referenced by `ResourceRating`, `ResourceReport`, `Lesson` snapshots and `ConceptCandidateRejection`. A delete destroys the record of the decision and frees the URL for immediate re-ingestion. |
| **Dropping the Khan `/pt/` rows outright.** | Ten attached SQL lessons with no replacement, when the teaching content is on the page as a measurable YouTube video. |
| **A `serveable` boolean column on `Resource`.** | Derivable from `type`, `url` and `status`; a stored copy is a third thing to sync with a classifier that will change. `schema.prisma:65-72` already says not to add a column for derived pickability. |
| **Making any of this an LLM call.** | Every rule is deterministic over a string or an integer. |

---

## Codebase facts (verified 2026-08-17)

**Ingestion seams**

- `classifyNonTeaching` has exactly one non-script call site: `createChild`
  (`src/lib/agents/decomposition/upsert-resource.ts:601`). Verified by
  `grep -rn "classifyNonTeaching" src scripts`.
- A flagged child is created with `status: 'deprecated'` +
  `deprecationSeverity: 'soft'` and excluded from `embedTasks`
  (`upsert-resource.ts:645-646`, `:673`).
- The **root** path creates its row with `status: 'pending_review'` and no content
  classification (`upsert-resource.ts:224-254`, status at `:248`).
- `upsertResource` is called from `web-fallback.ts:602` (discovery) plus seed/verify paths;
  `createChild` recurses at `upsert-resource.ts:686`.
- Only `upsert-resource.ts` and `src/lib/agents/map/generate-onramp.ts` create `Resource`
  rows. Verified by `grep -rln "resource.create\|resource.upsert" src`.

**Removal seam**

- `applyPendingReview` `reject` sets `status: 'deprecated'` + severity then calls
  `dropCandidateLinks`, in one transaction (`pending-review.ts:310-319`).
- `dropCandidateLinks` marks affected question banks stale, deletes the `ConceptResource`
  rows, and calls `recomputeReadiness` per affected Path (`pending-review.ts:224-250`).
- Built `Track`s are deliberately **not** touched by a rejection (`pending-review.ts:14-18`).
- `scripts/deprecate-furniture.ts:128` calls `applyPendingReview` rather than writing
  `status` — the precedent S8 follows, including dry-run-by-default and `requireTargetAck`.

**The re-type path (S6's territory)**

- `ResourceUpdateFields` = `durationMin`, `title`, `summary`, `difficulty`,
  `requiresPurchase` (`src/lib/curation/update-resource.ts:34-43`). No `type`.
- `resourceUpdateSchema` is a `z.strictObject(...).partial()` over the same five fields
  (`src/lib/api/resource-update-schema.ts:28-42`), and its header states the deliberate
  exclusion of `type` with its reason (`:12-13`).
- `CONTAINER_TYPES = new Set(['course', 'interactive', 'docs', 'book'])`
  (`src/lib/agents/decomposition/router.ts:52`); consulted at `:106`. `article` and `video`
  are the only non-container types.
- ⚠️ `classify()` returns `{ kind: 'atomic' }` for a non-container type **without any
  fetch** (`router.ts:106-108`), and `CONTAINER_TYPES` is documented as a candidate signal
  the doc-TOC router then overrides by reading the page (`router.ts:41-47`). So `type` gates
  **whether the page is examined**, not whether the row is a container.
- The re-decompose path reads `type`: `decomposition-review/route.ts:141` calls
  `decompose()`, which calls `classify(input)` at
  `src/lib/agents/decomposition/decompose.ts:137`. That route carries a `force` flag which
  bypasses the gate (`decomposition-review/route.ts:15`).
- `ResourceType` enum: `article`, `video`, `course`, `interactive`, `docs`, `book`
  (`prisma/schema.prisma:300-307`).
- Precedent for a one-shot re-type driver: `scripts/retype-ocw-sessions.ts` (6.042J
  `book` → `article`, dry-run default, `requireTargetAck('retype-ocw-sessions', …)`).
- `updateResource` already stamps `durationSource: 'reviewer'` when `durationMin` is
  supplied (`update-resource.ts:92-94`) — the provenance precedent a type edit follows.

**Classification inputs that already exist**

- `urlKind(url)` parses Khan's `/a|v|e|pt|pi/` segment, returning `null` for a landing or
  unit page (`src/lib/curation/khan-probe-duration.ts:47-49`). ⚠️ That file is
  **untracked** — see the precondition.
- `MIN_CONTENT_WORDS = 400` (`src/lib/curation/duration-estimate.ts:38`), already the
  "we have read chrome, not content" floor in five estimators.
- The probe reports `url`, `title`, `pageKind`, `videoIds`, `articleWords`,
  `articleWordsBeforeExpand`, `collapsedExpanded`, `workedExamples`, `widgets`,
  `mainWords`, `hasEditor`, `blocked`, `bodyWords` (`docs/audits/khan-probe.js:57-85`).
  `hasEditor` and `pageKind: 'challenge'` both key off
  `.ace_editor, iframe[src*="scratchpad"]` (`:67`, `:81`).
- `KhanProbe` already declares `url`, `pageKind`, `videoIds`, `articleWords`,
  `articleWordsBeforeExpand`, `collapsedExpanded`, `workedExamples`, `widgets`,
  `hasEditor`, `blocked` — but **not** `title` or `mainWords`
  (`khan-probe-duration.ts:16-30`). S4 needs both; the batch files carry them.
- `proposeKhanDuration` already compares `urlKind(storedUrl)` to `urlKind(probe.url)` and
  returns *unmeasured* on a mismatch (`khan-probe-duration.ts:67-71`). It detects defect 1
  and **marks nothing** — the row keeps its wrong type. This is the single closest existing
  thing to a clause-6 rule and it is a dead end by construction.
- `classifyNonTeaching`'s two-signal construction (`non-teaching.ts:207-210`) is the
  precedent for both the prose-floor-plus-widget pairing and the title-mismatch flag.

**Pickability and the review surface**

- Pickable is derived: `status='active'` AND `decompositionStatus='atomic'`, with an
  explicit "do not add a pickable column" (`prisma/schema.prisma:65-72`).
- `listPendingReview` returns only roots with `parentResourceId: null` and
  `status: 'pending_review'`, each with **direct** children only
  (`pending-review.ts:109-155`).
- `ApplyInput` supports `approve` / `reject` / `decompose`; reject carries `severity` and
  `cascade` (`pending-review.ts:190-193`). **No pending-resources API change is needed** —
  a serveability reject is an existing call shape.
- The skill is 138 lines of markdown at
  `.claude/skills/review-pending-resources/SKILL.md`; rubric items 1–5 at lines 24–28,
  decision mapping at 30–49.

**Measured populations** — from `scripts/census-serveability.ts` (read-only, written during
the item-1 investigation, currently untracked) against
`aws-1-us-west-1.pooler.supabase.com:6543/postgres` on 2026-08-17.

- 2,309 `Resource` rows; 2,011 pickable; 702 attached to ≥1 concept.
- `type='interactive'` pickable by host: khanacademy.org 32 (10 attached),
  openlearninglibrary.mit.edu 15 (1 attached), visualgo.net 1 (1 attached).
- Khan pickable by URL kind: `/v/` 723, `/a/` 144, `/pi/` 19, `/pt/` 11,
  `/a/`-typed-`interactive` 2.
- Clause 6's free rule (a `/a/` URL not typed `article`, or a `/v/` URL not typed `video`)
  matches **8 / 3 / 1**. The `/a/`-typed-`interactive` pair is a subset; the rule finds six
  more that a type-only filter misses.
- 526 Khan rows have probe output in `docs/audits/khan-batch-*.json*`; 138 reported article
  prose. Of those 138: 50 under the 400-word floor, 44 of which carry ≥1 widget and 6 none;
  43 clear the floor while carrying ≥10 widgets. 32 probed rows reported `hasEditor: true`.

**Constraints that bite this plan**

- ⚠️ **`docs/audits/` is git-ignored** (`.gitignore:65`, verified with `git check-ignore -v`).
  The 526 probe artifacts exist only on this machine, so S5's *report* is disposable and its
  *classifier inputs* are not reproducible from a fresh clone. Same footing the Khan
  duration backfill ran on.
- `npm test` is unit-only and safe; `npm run test:int` hits the real dev DB and requires
  stopping the dockerized workers first (`testing.md`).
- **No block touches `prisma/schema.prisma`**, so the `prisma-migrations.md` `DROP INDEX`
  hazard does not arise. If a block acquires a migration, that changes and the warning must
  be copied into its brief verbatim.
- No new dependencies anywhere in this plan.

### NEEDS VERIFICATION

- **`NEEDS VERIFICATION`: that every Khan `/pt/` row's embedded video resolves to a
  duration.** The unmeasured report lists 11 `/pt/` rows carrying a video id; S9 must
  confirm per row, and a `/pt/` row whose video does not resolve is excluded outright
  (resolved open question 2).
- **`NEEDS VERIFICATION`: whether the 15 MIT Open Learning Library `interactive` rows are
  genuinely interactive.** Resolved as: S5's report lists them and S8 re-types rather than
  deprecates any that are readings (resolved open question 1). ⚠️ **New evidence, and it
  points at a third answer:** all 15 are MITx 6.036 URLs of the form
  `…/jump_to/block-v1:…+type@sequential+block@<name>`. An edX **`sequential`** block is a
  unit containing several child pages — so these may be *containers* misfiled as atomic
  leaves (clause 3) rather than interactive pages (clause 5), which would make the repair a
  decompose, not a re-type and not a deprecate. Nobody has opened one; S5 must, and S8 must
  not act on this host until it has.

---

## Sequencing

Pipeline before backfill, for `library-quality.md`'s reason: repairs made before the
pipeline is fixed get re-contaminated by the next sourcing run. **The re-type path lands
before the removal sweep**, or the sweep destroys the rows clause 6 would have repaired.

```
S1  row-level serveability classifier          base: main
└── S2  wire into both ingestion seams         base: S1
    └── S3  probe-level serveability rules     base: S2
        └── S4  metadata-integrity classifier (clause 6)   base: S3
            └── S5  measurement report (read-only)         base: S4
                └── S6  make `type` correctable            base: S5
                    └── S7  review skill = the final gate  base: S6
                        └── S8  removal + re-type sweep    base: S7
                            └── S9  Khan /pt/ repoint      base: S8
```

One linear stack. S3 and S4 stack rather than branching because both add modules that S5
imports together, and a parallel edit to the shared barrel is a guaranteed conflict.

S5 is read-only and is the gate on S8's population: nobody decides what to deprecate before
the report exists. S9 is last because it is the only block that changes what a row *points
at* — keeping it terminal means every earlier block is verifiable without reasoning about a
URL that moved.

## Explicitly deferred

- **A host-agnostic content probe.** Clauses 1, 2, 4, 5 and 6 are only decidable from a
  page, and outside Khan we have no probe. This plan measures Khan and leaves ~1,200
  non-Khan rows unmeasured on the page-level clauses. Largest known gap, and deliberate:
  the standard is enforced going forward for every host (S1/S2 are host-agnostic) and
  measured retroactively only where evidence already exists.
- **Clause-6 enforcement at ingestion.** Detection feeds review and the sweep; the create
  path does not self-correct. See Locked decisions.
- **Clause 1 and 2 (liveness, access barriers).** Already covered by the existing rubric and
  by `verify-dead-link.ts` / the reports pipeline. Untouched here.
- **Retrofitting the standard into `non-teaching.ts`.** Different question, both stay.
- **Broken built Tracks.** A deprecated row stays in the immutable Track snapshots that
  placed it. Documented design; triage is manual.
- **The 43 practice-heavy articles that clear the prose floor.** Left in on purpose;
  tightening needs a measurement, not a threshold chosen to catch them.
- **`durationMin IS NULL` (169 / 83 / 25).** `library-quality.md`'s B4. Failing to measure a
  row is not the same as deciding it is unserveable.
- **Re-typing to `course`, `docs` or `book`.** S6 permits `article` and `video` only; a flip
  into a container type is the re-decompose decision `resource-update-schema.ts` describes,
  and `action: 'decompose'` already exists for it.

## Open questions for you

All three prior questions are resolved and recorded in Locked decisions (re-type after a
spot check; exclude an unresolvable `/pt/` row outright; move `urlKind`). One new one:

1. **`OPEN` — S8's dry-run output is the last human checkpoint before 60-odd rows leave the
   library.** The brief requires a printed dry run reviewed by you before `--apply`. Confirm
   you want that gate per-run rather than once for the whole sweep.

---

# Block briefs

## S1 — Row-level serveability classifier (~250 LOC)

**Base branch:** `main`
**Files owned:**
- `src/lib/curation/serveability.ts` (new)
- `src/lib/curation/serveability.test.ts` (new)
- `src/lib/curation/khan-probe-duration.ts` (modify — `urlKind` moves out, imported back)
- `scripts/apply-khan-durations.ts` (modify — import path only)
- `scripts/report-unmeasured.ts` (modify — import path only)

**What it does.** Introduces `classifyServeability({ type, url, decompositionStatus })`, a
pure verdict over a row's stored fields with no I/O, implementing the standard's clauses 3
and 5 for everything decidable without a page. Shaped deliberately like
`classifyNonTeaching`: a discriminated union verdict plus a named reason, so a caller cannot
read a boolean and lose the why. `urlKind` moves here from `khan-probe-duration.ts` and is
imported back by it, so Khan's content-kind parsing has one home.

Rules: `type = 'interactive'`; Khan `/e/`, `/pi/`, `/pt/` content kinds; a Khan URL with no
content-kind segment on a row whose `decompositionStatus` is `atomic`.

**Out of scope.** Any rule needing the rendered page (S3 owns those). Clause-6 comparisons
(S4). Wiring this into anything (S2). No caller changes beyond the two script import paths.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/curation/serveability.test.ts` (unit, pure). Must cover each rule firing,
each rule *not* firing on a near-miss, and the non-Khan passthrough.

**Acceptance criteria.**
- [ ] `classifyServeability({ type: 'interactive', url: 'https://visualgo.net/en/heap' })` returns a non-serveable verdict whose reason names the type rule.
- [ ] A Khan `/pi/`, `/pt/` or `/e/` URL returns non-serveable regardless of stored `type`; a Khan `/a/` or `/v/` URL typed `article`/`video` returns serveable.
- [ ] A Khan URL with no content-kind segment returns non-serveable when `decompositionStatus: 'atomic'` and **serveable** when `'decomposed'` — a container is not required to teach.
- [ ] A non-Khan URL (`react.dev`, `docs.python.org`) typed `article` returns serveable; no rule fires on hostname alone.
- [ ] `urlKind` is exported from `serveability.ts` and `khan-probe-duration.ts` imports it rather than declaring its own; `grep -c "function urlKind" src/` returns 1.
- [ ] `npm test` passes and `proposeKhanDuration`'s existing tests are unchanged — the move is not allowed to alter duration behaviour.

## S2 — Enforce row-level serveability at both ingestion seams (~140 LOC)

**Base branch:** `S1`
**Files owned:**
- `src/lib/agents/decomposition/upsert-resource.ts` (modify)
- `tests/integration/serveability-ingestion.int.test.ts` (new)

**What it does.** Calls `classifyServeability` at both `Resource` creation points — the
discovery root (`upsert-resource.ts:224`) and `createChild` (`:601`) — and creates a
non-serveable row as `status: 'deprecated'`, `deprecationSeverity: 'soft'`, excluded from
`embedTasks`. Reuses the furniture branch's exact shape and composes with it: a row failing
either classifier is deprecated, and the emitted `logWarn` names which one fired. Closes
gap 1 — the open-web path is guarded for the first time.

**Out of scope.** Probe-level rules (S3). Clause-6 detection (S4) — a create path does not
self-correct types; see Locked decisions. Do not change `childStatus` inheritance, the
canonical-URL dedup, or the membership/embedding ordering, all of which carry ⚠️ comments.

**Migration:** none
**New deps:** none

**Tests.** `tests/integration/serveability-ingestion.int.test.ts` (`describeDb`). Stop the
dockerized workers before `npm run test:int` (`testing.md`).

**Acceptance criteria.**
- [ ] `upsertResource` with an atomic root whose `type` is `interactive` writes a row with `status = 'deprecated'` and `deprecationSeverity = 'soft'`, not `pending_review`.
- [ ] That root's id does **not** appear in the returned `atomicIds`.
- [ ] A `createChild` child on a Khan `/pi/` URL is created (the row exists, its URL is in the table) and is `deprecated` + `soft`.
- [ ] A serveable root is still created `pending_review` and still appears in `atomicIds` — the change is inert on good rows.
- [ ] A row failing both `classifyNonTeaching` and `classifyServeability` is deprecated once, with one `logWarn` line per classifier and no duplicate row.
- [ ] Re-running the same decomposition creates no second row for a deprecated URL (the dedup still collapses onto it).

## S3 — Probe-level serveability rules (~260 LOC)

**Base branch:** `S2`
**Files owned:**
- `src/lib/curation/serveability-probe.ts` (new)
- `src/lib/curation/serveability-probe.test.ts` (new)

**What it does.** Adds `classifyServeabilityFromProbe(probe, row)` for the clause 4 and 5
rules that need the rendered page: prose under `MIN_CONTENT_WORDS` **paired with** ≥1
exercise widget; a code editor with no prose; a `mainWords / articleWords` ratio identifying
a body that is a shell around an embedded widget; a chain-step title or a URL under a
challenge container. Imports `MIN_CONTENT_WORDS` from `duration-estimate.ts` rather than
restating it.

Every rule here is paired or absolute — none fires on a single weak signal. The prose floor
alone is explicitly **not** a verdict: six probed rows sit under it with zero widgets and are
real short lessons.

**Out of scope.** Clause-6 comparisons (S4) — `pageKind` and `title` are S4's inputs, not
this module's. The driver that runs this over the batch files (S5). Any DB access: this
module is pure and takes a probe object.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/curation/serveability-probe.test.ts` (unit, pure).

**Acceptance criteria.**
- [ ] `articleWords: 189, widgets: 6` returns non-serveable naming the practice-page rule; `articleWords: 189, widgets: 0` returns **serveable**.
- [ ] `articleWords: 492, widgets: 31` returns serveable — over the floor is over the floor, whatever the widget count.
- [ ] `articleWords: 4, mainWords: 1126` returns non-serveable naming the shell rule, and does so even with `widgets: 0`.
- [ ] `hasEditor: true, articleWords: null` returns non-serveable; `hasEditor: true` with prose over the floor returns serveable.
- [ ] A title of `Clue #4` or `Level 3: Challenge`, or a URL containing `/cryptochallenge/`, returns non-serveable naming the chain rule; `Control Systems - Feedback Loops` does not.
- [ ] `blocked: true` returns neither verdict — it returns an explicit "no evidence" outcome, so a bot wall is never read as a quality failure.
- [ ] The module imports `MIN_CONTENT_WORDS`; `grep -c "400" src/lib/curation/serveability-probe.ts` returns 0.

## S4 — Metadata-integrity classifier, clause 6 (~250 LOC)

**Base branch:** `S3`
**Files owned:**
- `src/lib/curation/metadata-integrity.ts` (new)
- `src/lib/curation/metadata-integrity.test.ts` (new)
- `src/lib/curation/khan-probe-duration.ts` (modify — add `title` and `mainWords` to `KhanProbe`)

**What it does.** Implements the standard's clause 6 as `classifyMetadataIntegrity(row, probe?)`,
returning a list of named discrepancies rather than a single verdict — a row can lie about
two things at once, and each has a different repair. Four comparisons, each carrying the
repair it implies (`retype` to a named type, or `review` for a human):

1. stored `type` vs `urlKind(storedUrl)` — **no probe required**, the free rule;
2. `probe.pageKind` vs stored `type`;
3. `urlKind(probe.url)` vs `urlKind(storedUrl)` — the redirect case;
4. stored `title` vs `probe.title`, normalized for Khan's `(article) | Khan Academy` suffix
   — always `review`, never a `retype`, because it is too noisy to act on alone.

Adds `title` and `mainWords` to the `KhanProbe` type; both are already emitted by the probe
and present in the batch files but were never declared.

**Out of scope.** Performing any repair — this module reports, S6 makes the repair possible
and S8 applies it. Serveability rules of any clause (S1/S3). Enforcement at ingestion, which
Locked decisions rules out.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/curation/metadata-integrity.test.ts` (unit, pure).

**Acceptance criteria.**
- [ ] A row typed `interactive` on a `/a/` URL yields one discrepancy with repair `retype` to `article`, **with no probe argument supplied**.
- [ ] A row typed `interactive` whose `probe.pageKind` is `article` yields a `retype`-to-`article` discrepancy.
- [ ] A stored `/a/` URL whose `probe.url` is `/v/` yields a discrepancy naming the redirect; a stored `/a/` URL whose `probe.url` is a different `/a/` slug yields **none** (slug drift is normal, kind change is not).
- [ ] `title: 'Central limit theorem'` against `probe.title: 'Central limit theorem (video) | Khan Academy'` yields no title discrepancy; against `'Introduction to residuals (article) | Khan Academy'` yields one with repair `review`.
- [ ] A row with two simultaneous defects returns two discrepancies, not one.
- [ ] A clean row returns an empty list, and an empty list is distinguishable in the type system from "not checked".
- [ ] `KhanProbe` declares `title: string` and `mainWords: number`; `proposeKhanDuration`'s behaviour and tests are unchanged.

## S5 — Measurement report over the existing probe evidence (~200 LOC)

**Base branch:** `S4`
**Files owned:**
- `scripts/report-serveability.ts` (new)
- `scripts/census-serveability.ts` (modify — fold the ad-hoc census into the driver, or delete it in favour of the new one)

**What it does.** Discharges item 2: a **read-only** driver that joins the production library
against the 526 existing Khan probe artifacts and reports, per clause and per rule, how many
rows fail — split by pickable and attached, and split by *repair* (deprecate vs. re-type).
This report is the input to S8's population and the answer to "how does our library fail the
standard". Runs through `scripts/run-against-prod.ts`; no `--apply` flag exists.

It must also print a sample of the 15 MIT Open Learning Library `interactive` rows with
their URLs, so the re-type-vs-deprecate split on that host stops being an open question.

**Out of scope.** Any write, any `--apply`, any browser. Non-Khan page-level measurement —
there is no probe for those hosts (Explicitly deferred). Deciding anything: this block
reports and stops.

**Migration:** none
**New deps:** none

**Tests.** None — a read-only reporting driver over uncommitted local artifacts, consistent
with `report-unmeasured.ts` and `measure-unknown-durations.ts`. The pure logic it calls is
tested in S1/S3/S4.

**Acceptance criteria.**
- [ ] Running it prints the resolved target label and exits non-zero if `DATABASE_URL` is unset; it has no `--apply` flag (`grep -c "apply" scripts/report-serveability.ts` returns 0).
- [ ] Output groups failures by clause, and within a clause by rule, each line carrying **all / pickable / pickable-and-attached** counts.
- [ ] Every row counted as failing clause 6 is reported with its implied repair (`retype <type>` or `review`), and the deprecate and re-type totals are printed separately.
- [ ] The report names the number of rows for which no probe artifact exists, rather than silently counting them as passing.
- [ ] The 15 `openlearninglibrary.mit.edu` interactive rows are listed individually with URL and title.
- [ ] Two consecutive runs produce identical output (no clock or ordering nondeterminism).

## S6 — Make `type` correctable on an atomic row (~130 LOC)

**Base branch:** `S5`
**Files owned:**
- `src/lib/api/resource-update-schema.ts` (modify)
- `src/lib/curation/update-resource.ts` (modify)
- `src/lib/curation/update-resource.test.ts` (modify)
- `src/app/api/playground/resources/route.ts` (modify — doc comment only)

**What it does.** Adds `type` to the update whitelist, constrained to `article | video` and
rejected on any row whose `decompositionStatus` is not `atomic`. This is the repair path
clause 6 needs and the reason S8 can correct a mislabelled row instead of deprecating it.
The schema header's existing paragraph explaining why `type` was excluded must be **rewritten
to state the narrowing and why it preserves the original reason** — not deleted.

**Out of scope.** Re-typing into `course`, `docs` or `book` (`action: 'decompose'` owns
that). Changing `url`, `status` or `decompositionStatus`. Any bulk driver — S8 owns the
sweep. Do not touch the `durationSource: 'reviewer'` stamping logic. Do **not** add a guard
against the re-decompose interaction — it is a documentation duty (below), and the
`force` bypass already exists.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/curation/update-resource.test.ts` (unit) for the seam; the schema is
covered by the existing `report-triage-schema.test.ts` pattern for whitelist rejection.

**Acceptance criteria.**
- [ ] `resourceUpdateSchema.safeParse({ resourceId: 'r', fields: { type: 'article' } })` succeeds; `{ type: 'book' }`, `{ type: 'course' }`, `{ type: 'docs' }` and `{ type: 'interactive' }` all fail.
- [ ] `updateResource` on a `decomposed` row with `{ type: 'article' }` returns a refusal result naming the decomposition status, and writes nothing.
- [ ] `updateResource` on an `atomic` row with `{ type: 'article' }` returns the updated row with `type: 'article'`.
- [ ] A `type`-only edit does **not** mark the embedding stale (type is not in the embedded text) while a `title` edit still does.
- [ ] `resource-update-schema.ts`'s header no longer claims `type` is excluded. Its replacement states that the atomic-only constraint is the safety argument, that the two permitted targets are scope rather than safety, and does **not** repeat the "changes router classification" reasoning.
- [ ] The header records the re-decompose interaction: a row retyped to `article` short-circuits a later `decompose()` via `classify()`, and `force` is the bypass.
- [ ] Every other whitelisted field behaves exactly as before (existing tests unchanged).

## S7 — Make review-pending-resources the real final gate (~160 LOC)

**Base branch:** `S6`
**Files owned:**
- `.claude/skills/review-pending-resources/SKILL.md` (modify)

**What it does.** Discharges item 4. Extends the rubric from five items to seven — adding
**standalone** (clause 4) and **consumed, not performed** (clause 5) — and adds clause 6's
metadata-integrity checks to the existing metadata item, including the four comparisons a
reviewer with the page open can make by eye. Adds the decision mappings: a serveability
failure is **reject soft**; a stored type contradicted by the page is a **PATCH `type`
correction first**, then grade normally. States the precedence explicitly: **a clause-6
repair outranks a clause-5 exclusion**, so a row typed `interactive` that the page serves as
an article is re-typed and kept, never rejected on its stale type.

**Out of scope.** The container-sampling machinery, the exposed-index rules, the
approve-root-last section and the requeue path — all load-bearing and untouched. No API
changes (`ApplyInput` already covers every action this needs). No changes to the report
table's shape beyond the new decision values.

**Migration:** none
**New deps:** none

**Tests.** None — the skill is markdown. Its correctness is checked by S8's dry run agreeing
with a hand review of a sample, which is called out in S8's criteria.

**Acceptance criteria.**
- [ ] The rubric has seven numbered items; the two new ones name clauses 4 and 5 and cite `resource-standard.md` **by filename, not path**.
- [ ] The decision mapping states that a clause-4 or clause-5 failure is `reject` with `severity: "soft"`, and that `hard` is reserved for a dead link.
- [ ] The mapping states the clause-6-outranks-clause-5 precedence with the `interactive`-page-serves-an-article case as its worked example.
- [ ] The PATCH example shows a `type` correction and states the two permitted targets and the atomic-only constraint.
- [ ] The skill warns that a row retyped to `article` will short-circuit a later `action: "decompose"` on that row, and names `force` as the bypass — so a reviewer does not retype a row they also mean to decompose.
- [ ] The skill's `allowed-tools` still permits every call the new steps require, with nothing added that they do not.
- [ ] The existing sections on container sampling, exposed index pages and approving the root last are byte-identical to before.

## S8 — Sweep the library: deprecate what fails, re-type what is mislabelled (~220 LOC)

**Base branch:** `S7`
**Files owned:**
- `scripts/sweep-serveability.ts` (new)

**What it does.** Discharges item 5. A dry-run-by-default driver that walks the population
S5 reported and applies the right repair to each row: `applyPendingReview({ action:
'reject', severity: 'soft' })` for a serveability failure, and an `updateResource` `type`
correction for a clause-6 mislabel. Modelled on `deprecate-furniture.ts` — same
`requireTargetAck` guard, same dry-run default, same "the population is whatever the
classifier says, never a hand-typed list" rule, same idempotence.

**The precedence is enforced in code, not left to the operator**: a row with a clause-6
`retype` repair is re-typed and **never** deprecated in the same run, even when a
serveability rule also fires on its stale type. Rows whose only clause-6 finding is a
`review` repair are printed and skipped.

**Out of scope.** The Khan `/pt/` repoint (S9) — this driver must skip `/pt/` rows entirely
and say how many it skipped. Deleting anything. Touching `Track` or `Lesson` rows. Any
change to the classifiers.

**Migration:** none
**New deps:** none

**Tests.** `tests/integration/sweep-serveability.int.test.ts` (`describeDb`) for the
precedence rule and idempotence against a seeded fixture. Stop the dockerized workers first.

**Acceptance criteria.**
- [ ] Default invocation writes nothing and prints every candidate with its rule, its repair, and whether it is attached to a concept.
- [ ] Against a non-local host without `--target-host=<hostname>`, `--apply` refuses and exits non-zero.
- [ ] A seeded row typed `interactive` whose probe evidence says `article` is re-typed to `article` and its `status` is unchanged — it is not deprecated.
- [ ] A seeded `interactive` row with no contradicting evidence is deprecated `soft`, and its `ConceptResource` links are gone with the affected Path's readiness recomputed.
- [ ] Khan `/pt/` rows are skipped, and the count of skipped `/pt/` rows is printed.
- [ ] A second `--apply` run reports zero candidates and writes nothing.
- [ ] The printed dry-run totals match S5's report for the same rules (the two must not disagree about the population).
- [ ] No `Track`, `Lesson` or `LessonResource` row is written; verified by comparing `max(updatedAt)` before and after, as `deprecate-furniture.ts --tracks` does.

## S9 — Repoint Khan /pt/ rows at their embedded video (~200 LOC)

**Base branch:** `S8`
**Files owned:**
- `scripts/repoint-khan-pt.ts` (new)

**What it does.** The last repair: for each Khan `/pt/` row, resolve the YouTube id the
probe recorded, and rewrite the row to point at the video — `url`, `type: 'video'`, and a
measured `durationMin` with `durationSource: 'api'` — so the 10 attached SQL lessons keep
teaching and the challenge half goes away. A `/pt/` row whose video does not resolve is
deprecated `soft` through the reject seam instead, per the resolved open question.

**Because it changes `url`, it cannot go through `updateResource`** (the whitelist excludes
`url` as the row's identity, and S6 does not change that): this driver writes `url` directly
with a documented comment saying why, and must handle the case where the target video URL
**already exists as another row** — in which case the `/pt/` row is deprecated rather than
repointed, since repointing would violate the unique-URL constraint.

**Out of scope.** Every other population (S8 owns them). Re-deriving `conceptsTaught`,
`summary` or `title` — a repointed row keeps its metadata, and a wrong title is a clause-6
finding for review, not this driver's job. Any change to the classifiers or the schema.

**Migration:** none
**New deps:** none

**Tests.** `tests/integration/repoint-khan-pt.int.test.ts` (`describeDb`) for the three
outcomes: repointed, deprecated-unresolvable, deprecated-URL-collision.

**Acceptance criteria.**
- [ ] Dry run by default; `--apply` against a non-local host refuses without `--target-host`.
- [ ] A `/pt/` row with a resolvable video ends with a `youtube.com` or `youtu.be` `url`, `type = 'video'`, a non-null `durationMin` and `durationSource = 'api'`.
- [ ] Its `ConceptResource` links **survive** the repoint — the point of the block is that the attached lessons are not lost.
- [ ] A `/pt/` row whose video id does not resolve is deprecated `soft` via `applyPendingReview`, not left half-edited.
- [ ] A `/pt/` row whose target video URL already exists as another `Resource` is deprecated `soft` and the collision is printed; no unique-constraint error is raised.
- [ ] The driver reports, per row, which of the three outcomes it took, and the three counts sum to the number of `/pt/` rows found.
- [ ] A second run finds no `/pt/` rows to repoint.
