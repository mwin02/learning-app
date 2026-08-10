# Library quality plan — pipeline fixes + library backfill

**Status:** active — not started · **Blocks:** P1–P7 (pipeline), B1–B6 (backfill); no PRs yet
· **Block IDs:** `P`, `B` (scoped to this plan) · **Started:** 2026-08-05

> **Predates `/plan-feature`.** Its blocks carry no acceptance criteria and no LOC budgets.
> Before running `/orchestrate-feature` against it, retrofit both — see
> [../../.claude/skills/plan-feature/references/block-brief.md](../../.claude/skills/plan-feature/references/block-brief.md).

Companion to `docs/audits/library-sanity-review.md` (the audit that motivated this).

Two halves, in dependency order:

- **Part 1 — Pipeline.** Stop producing bad rows. Must land first; otherwise Part 2's
  repairs get re-contaminated by the next sourcing run.
- **Part 2 — Backfill.** Repair the 2,008 rows already filed.

---

## The diagnosis in one paragraph

Three fields are written by the ingestion pipeline with **no way to express "unknown"**:
`durationMin` (non-null `Int`), `conceptsTaught` (non-null `String[]`), and — before topic
filing T1–T4 — `topic`. When a derivation step fails or is skipped, each field gets a
plausible-looking fill value that is indistinguishable downstream from a real measurement.
Topic already had this lesson learned: `ResourceTopic.origin` + `relevance` exist precisely so
a filing can say "inherited, unknown". **Duration and concepts never got the same treatment.**
That is the single structural defect behind every symptom in the audit.

## Not in this plan: rung-0 starvation (retrieval-side)

`docs/plans/archive/rung0-starvation.md` fixes a defect that looks adjacent and is not: the sourcing
ladder counted rung-0's **raw search hits** against its target, so any concept with three
library rows inside the distance ceiling never reached web discovery — regardless of whether
those rows taught it. Every plan here is **ingestion-side** (fields written with no way to say
"unknown"); that one is **retrieval-side**, and neither plan's fixes touch the other's defect.

The strongest evidence they are disjoint, measured on production 2026-07-31: the surviving
`precalculus` hole `function-transformations-and-compositions` is saturated by rows at
**d=0.251–0.300** filed at relevance **0.80/0.90 by the classifier** — "Functions",
"Evaluating functions", "Worked example: evaluating expressions with function notation".
Well-filed, well-embedded, semantically close, and not one of them teaches transformations or
compositions. P3/B3 would move neither those rows nor those distances. (Contrast the same
plan's junk samples at d≈0.4+ and relevance 0.00 — this plan does reach *those*, and B5's
dedupe has a measurable retrieval cost there, but fixing them only changes *which* rows
saturate.) Shipped as R1–R2, 2026-08-01; nothing here was pulled forward for it.

---

# PART 1 — Pipeline defects

## P1. Concept derivation silently falls back to the parent's concepts ⚠️ highest severity

**Where:** `src/lib/agents/decomposition/concepts.ts:128-131`, consumed identically at
`doctoc.ts:253`, `manual.ts:64`, `youtube.ts:114` — all three spell
`derived?.conceptsTaught ?? (parentConcepts.length > 0 ? parentConcepts : [topic])`.

There is a **fourth inheritance site**: `doctoc.ts:238` assigns the parent's concepts to
nested sub-container children **unconditionally** — derivation deliberately runs only for
leaves, so no derivation is even attempted for these. 4 of the 306 matched rows below are
such `decomposed` containers. And at all four sites the `[topic]` last-resort fallback is
equally unmarked.

**What happens:** `deriveBatch` wraps the whole `generateObject` call in `try/catch`, logs to
`console.log`, and returns an empty map. Every ref in that batch then inherits the parent
container's entire concept array. Nothing is persisted to say it happened.

This directly violates the module's own header contract, which states children derive their own
concepts *"not an inherited slice of the parent's concepts"*.

**Proof it is batch-granular, not row-granular.** `CONCEPT_DERIVATION_CHUNK_SIZE = 25`, and the
affected children sit in contiguous, 25-aligned runs of `orderInParent`:

| container | children inheriting parent concepts | `orderInParent` run |
| --- | --- | --- |
| `linear-transformations-…-linear-algebra` | 50 | 0–49 (two batches) |
| `khan-academy-cryptography` | 50 | 25–74 (two batches) |
| `probability-and-statistics` | 39 | 105–124, 225–243 |
| `mit-ocw-…-unit-4-probability` | 33 | 0–32 |
| `matrices-precalculus-math` | 25 | 0–24 |
| `random-variables-…-math` | 25 | 0–24 |
| `limits-and-continuity-ap-college-calculus-ab` | 25 | 25–49 |
| `theory-of-numbers-spring-2012` | 24 | 0–23 |
| `2-first-order-de-s` | 23 | 2–24 |

**306 children carry their parent's exact array.** Each run is one silently-failed LLM batch.

**Why it compounds:** `loadTopicVocab` (`concepts.ts:25`) grounds *future* derivations on the
concepts already in the library. Contaminated concepts become the vocabulary that the next
decomposition is told to reuse. And since the embedding is built over
`title + summary + conceptsTaught`, contamination degrades semantic search *and* the topic
classifier that files new resources — which is precisely the mislabeling risk that prompted
this review.

**Fix:**
1. Add `ConceptOrigin` provenance to `Resource` (`derived` | `inherited` | `fallback`),
   mirroring the `TopicFilingOrigin` precedent.
2. Retry a failed batch once, then **split it** — a 25-item batch failing is usually one
   malformed item poisoning the object parse, so bisecting recovers the other 24.
3. If derivation still fails, write the parent array **but stamp `inherited`** so it is
   findable and never silently trusted. Never let a failure be invisible. The stamp must
   also cover the `doctoc.ts:238` sub-container path and the `[topic]` fallback, or those
   rows stay silently `derived`-looking.
4. Promote the `console.log` to a real warning surfaced by the worker.
5. Exclude `inherited`-origin concepts from `loadTopicVocab` grounding, breaking the feedback loop.

## P2. `durationMin` has no guidance and no provenance

**Where:** `src/lib/agents/tools/web-fallback.ts:58` requires
`durationMin: z.number().int().min(1).max(6000)` from the model, but the prompt's only
guidance is one uncalibrated line (`web-fallback.ts:751`: *"durationMin is your best estimate
of time to consume end-to-end in minutes"*) — no per-type ranges, no instruction to read a
stated duration off the page, no permission to say "unknown". The model answers 20.

**And:** `src/lib/agents/decomposition/doctoc.ts:79` is literally `.default(20)`;
`manual.ts:58` uses `DEFAULT_DURATION_MIN`. Only `youtube.ts:108` reads a real value.

**Result:** 1,179 of 2,008 rows (59%) are exactly 20. Of 426 videos with YouTube API stats, 7
are 20m; of 810 without, 704 are (87%).

### The 20 has two independent causes, and they need different fixes

Measured 2026-08-05 while working a `/review-pending-resources` batch whose five containers
were uniformly 20 (KA Cryptography 75 children, MIT OCW 6.0002 15, MIT OCW 6.045J 23, +2).
Hand-correcting them against the rendered pages gave a **median error of ~4×**, worst case
`Frequency stability property short film` at 2:09 stored as 20 minutes.

**Cause A — manual/SPA path: never estimated at all.** `khanacademy.org` returns **HTTP 200,
3,038 bytes, `<title>Client Challenge</title>`** to the pipeline's exact headers
(`doctoc.ts:127`) — a JS bot wall, zero lesson links. Identical response to an ordinary Chrome
UA from curl, so it is not UA sniffing; any non-browser client fails it. KA therefore never
reaches doc-TOC (`doctoc.ts:140-144` bails to `human_review` on zero candidate links) and
enters via `decomposeManual`, whose header comment names Khan Academy as the motivating case.
There, `manual.ts:58` applies `DEFAULT_DURATION_MIN` unconditionally. **No estimate is ever
attempted** — this is a hardcoded constant, not a bad guess, and it is the library's single
largest source of placeholder durations.

**Cause B — doc-TOC: the model has nothing to estimate from.** Both MIT OCW roots scrape fine
over plain HTTP with the bot UA (6.045J lecture-notes → all 23 `mit6_045js11_lecNN` links;
6.0002 lecture-videos gallery → all 15), went through doc-TOC successfully, and still came out
uniformly 20. The reason is structural: **doc-TOC never fetches the child pages.** The
extraction model sees only the parent's `<title>`, a 2,000-char body snippet, and the link list
(`doctoc.ts:136-148`).

This bounds fix 3 below. "Read a stated duration off the page" can only ever act on link text,
because the only page in context is the *parent's* — calibration alone cannot fix doc-TOC
durations. The default is soft rather than a floor (the Lamar Differential Equations container
carries `{5: 2, 15: 1, 20: 1}`, so the model does emit real values on some page shapes), which
is why "permission to return null" is the load-bearing half of that fix, not the ranges.

**Fix:**
1. Add `durationSource` (`api` | `extracted` | `estimated` | `unknown`) to `Resource`.
   Stop encoding "we don't know" as a number that looks measured.
2. Remove the `.default(20)` in `doctoc.ts` — make the field optional and record `unknown`
   rather than inventing a value. **And delete `manual.ts:23`'s `DEFAULT_DURATION_MIN`** (Cause
   A): make `durationMin` optional on `ManualChildInput`, flow null + `unknown` through when the
   supplier didn't measure, and fix the header comment that currently advertises the default as
   intentional parity with doc-TOC. Then require the value from the browser agent/operator
   supplying the list — it is reading the rendered page already, the one context where the
   number is free.
3. Give the extraction prompt explicit calibration: typical ranges per `type`, an instruction
   to use any duration stated in the **link text or parent TOC** (`"Lecture 3 (50 min)"`) —
   not "the page", which doc-TOC never sees — and permission to return null. Per Cause B the
   null permission is what actually moves the number; the ranges only stop wild guesses.
   Deliberately **not** scoped here: fetching every child page to measure it. That would make
   OCW durations exact rather than merely honest, but it is a per-child fetch + parse budget
   change that deserves its own sizing, and `unknown` already beats a confident 20.
4. **Add a validation gate** at upsert: reject/flag a `book` or multi-unit `course` under
   30 minutes, and any atomic leaf over `MAX_ATTACHABLE_DURATION_MIN`. The audit found a book
   at exactly 6000 (the schema max — a clamp artifact) and 33 of 50 books at 20m.
5. **Reconcile containers with children.** 22 containers claim less than half their children's
   summed duration (`2-first-order-de-s`: 5m parent, 555m of children). A decomposed parent's
   duration should be derived from its children, not independently guessed.

## P3. Decomposed children inherit the parent's topic without classification

775 memberships carry `origin: inherited`. Per the schema comment, `relevance: 1.0` there means
*"unknown", not "certain"*. The correlation with the audit's per-chunk verdicts is essentially
perfect:

| topic | primaries | inherited | reviewer verdict |
| --- | --- | --- | --- |
| calculus | 479 | 395 (82%) | "dumping ground", 66 flags |
| javascript-react / sql / python / machine-learning | 97 / 117 / 68 / 21 | **100% each** | flagged |
| python-data-ml | 79 | 76 (96%) | flagged |
| statistics | 251 | 0 (classifier) | **zero topic defects** |
| linear-algebra / probability-and-statistics / rust / precalculus | — | 0 (precalculus: 1) | clean |

(Counts re-verified against the live DB 2026-07-29; the shelves have grown slightly since the
audit — sql added ~21 rows, every one inherited, which only sharpens the pattern.)

Every topic a reviewer called a dumping ground is inherited-filed; every classifier-filed topic
came back clean.

**Fix:** classify decomposed children on their own content at ingest rather than inheriting,
gated by the existing T2b guardrail. The parent's topic becomes a prior, not an answer.
Note the ordering constraint: this depends on P1, because the classifier reads embeddings built
over `conceptsTaught`.

## P4. `contested` measures pool size, not correctness

All 42 contested rows sit in the four thinnest topics — algebra (12), physics-mechanics (10),
graph-theory (8), rust (12). With `MIN_CENTROID_MEMBERS = 20`
(`src/lib/curation/topic-centroids.ts:35`), the first three skip the cheap pre-filter and fall
to k-NN, where an 8-member shelf cannot outvote calculus's 479. Spot-checking, most are
correctly filed: "Iterators in Rust" and "Kepler's Laws" are contested at relevance 0.00–0.30.

41 of 42 are primaries, so nothing is currently orphaned — but the schema comment anticipates
gating retrieval on `relevance`, and doing so today would starve exactly the thin shelves that
most need to grow.

**Fix:** make the guardrail pool-size-aware — a thin shelf should abstain, not contest. This is
the same failure `review-drain.ts:101` already reasons about ("the fix is a fallback, NOT a
lower `MIN_CENTROID_MEMBERS`").

## P5. Generated on-ramps can skip `ResourceTopic` entirely

7 of 20 `origin: generated` on-ramps have **zero** membership rows despite a set scalar
`Resource.topic` — invisible to topic-scoped retrieval. The other 13 are filed correctly, so
this is a gap in the generated-resource path, not a design choice.

**Fix:** route on-ramp creation through the `setPrimaryTopic` seam like every other writer, and
add the invariant to `assertMembershipInvariants`.

## P6. Container furniture enters as teachable leaves

Decomposition admits navigation and marketing pages as atomic resources: `about-the-course`,
`course-prerequisites`, Khan `Feedback` / `Checkpoint` / `what-s-next`, docs front-matter
(`Appendix`, `What Now?`, `Whetting Your Appetite`), a College Board interview, an exams index.

**Fix:** a cheap non-teaching classifier at decomposition time (title/summary heuristics plus
the existing junk-leaf signal — the schema notes low absolute centroid similarity "doubles as a
decent junk-leaf detector").

## P7. Vocabulary: subtopics compete with their parents

`eigenvalues-and-eigenvectors` (14) and `systems-of-linear-equations` (15) sit as peers of
`linear-algebra` (246 primaries); `multivariable-calculus` (17) and `differential-equations`
(11) as peers of `calculus` (479 primaries). `statistics` (251 primaries) and
`probability-and-statistics` (206 primaries) are so entangled that **all 251 statistics rows
carry a probability-and-statistics secondary**.

Ambiguous shelves are a standing generator of the mislabeling this plan exists to prevent.
Decide deliberately: either merge the near-duplicates, or formalize a parent/child topic
relation so a subtopic filing is not scored as a competing one. This is a **discussion item**,
not something to fix unilaterally — it touches `TOPIC_RELATIONS` and the warm-set.

---

# PART 2 — Backfill

Strict ordering, because each stage reads what the previous one writes:

```
concepts  →  re-embed  →  topics  →  durations (independent, may run in parallel)
```

Reclassifying topics before repairing concepts would file rows using corrupted embeddings and
bake today's errors in as "classifier-verified" — strictly worse than the honest `inherited`
label they carry now.

## B1. Repair contaminated concepts (~306 rows, hard floor)

Target the parent-array matches, which are exactly identifiable by the query in this plan's
audit — no LLM needed to *find* them. Re-run `deriveChildConcepts` per affected container with
the P1 retry/bisect fix in place. Stamp `ConceptOrigin` on every row touched.

Widen to the 554-row shared-array set only after spot-checking; some sharing is legitimate
(genuine 4-part series on one concept).

**Verification:** zero children whose concept array exactly equals their parent's without an
`inherited` stamp; no contiguous `orderInParent` runs remaining.

## B2. Re-embed everything touched by B1

`scripts/embed-resources.ts` already re-embeds where `embeddedAt < updatedAt`, so B1's writes
make these rows self-selecting. Current coverage is 2,008/2,008, so this is a refresh, not a
backfill. Recompute `TopicCentroid` rows afterwards — the centroids are means over these
vectors and are stale the moment B1 lands.

## B3. Reclassify the 775 `inherited` topic memberships

`scripts/reclassify-topics.ts` exists for exactly this backlog and its header documents it. Two
constraints from that header, both load-bearing:

- It **never refiles** — it records doubt. Moving primaries is `refile-quorum-topics.ts` (T4b),
  the quorum-gated pass.
- **Stop the compose workers first** (`docker compose --profile workers stop worker`).

**Do the ~12 whole-course parents by hand first**, because their children reclassify onto the
correct shelf for free:

| cohort | currently | should be |
| --- | --- | --- |
| Lamar Differential Equations (28 sections + root) | calculus | differential-equations |
| Lamar Calculus III chapter (~31 rows) | calculus | multivariable-calculus |
| Lamar CalcI *Review* chapter | calculus | precalculus |
| MIT 18.781 Theory of Numbers (9) | discrete-mathematics | number-theory |
| MIT 18.409 spectral graph theory (8) | discrete-mathematics | graph-theory |
| Khan "Journey into Cryptography" + RSA/Diffie-Hellman (~12) | discrete-mathematics | cryptography |
| Khan precalculus "matrices as data tables" (4) | linear-algebra | precalculus |
| PCA / linear-regression rows | linear-algebra | machine-learning |

Note several target shelves (`number-theory` 14, `graph-theory` 9, `differential-equations` 11)
are below `MIN_VOUCHABLE_POOL` — this is the deadlock `refile-quorum-topics.ts` was written to
break, so route these through it as a cohort rather than row-by-row.

## B4. Re-derive durations (~1,177 rows)

**The YouTube API is not the lever here** — only 7 of the 1,177 placeholder rows are YouTube
URLs. Three hosts carry 98%:

| host | rows | recovery strategy |
| --- | --- | --- |
| khanacademy.org | 879 (704 video, 139 article, 35 interactive) | ⚠️ **strategy replaced — see below.** Original plan (extract the embedded YouTube id, then batch the YouTube Data API) cannot work: the extraction step is exactly the HTML fetch P2's Cause A rules out. |
| tutorial.math.lamar.edu | 179 | Static HTML articles → deterministic reading-time from word count. No LLM. |
| ocw.mit.edu | 94 | Lecture notes/PDFs → page or word count; lecture videos → media duration. |
| everything else | ~26 | Hand-review. |

### The Khan Academy 879 — replacement strategy

The youtube id **is** on a KA page, but only after the bot challenge is solved and the SPA has
rendered; it is absent from every server-side response. A different route works instead: KA's
**persisted-query GraphQL endpoint answers the bot UA directly, bypassing the challenge that
walls HTML.** Verified 2026-08-05:

```
GET /api/internal/graphql/ContentForLearnableContent
    ?hash=2300666574&lang=en&app=khanacademy&variables={"id":"716378217","kind":"Video"}
→ 200, 9,893 bytes, "duration": 176, "youtubeId": "FlIG3TvQCBQ"
```

`duration` is in **seconds and exact** — 176 for `one-time-pad`, matching the browser-measured
2:56 precisely. Parameter brittleness is the opposite of what it looks like:

| param | required? | behaviour |
| --- | --- | --- |
| `hash` | **yes** | per-operation, stable; omit → `400 No hash= specified` |
| `pcv` | no | deploy version; omitted → still 200, and a stale one → still 200 |
| `fastly_cacheable` | no | cache hint only |

`pcv` was seen rotating mid-session (`87344f52…` → `d5e1f475…`) while `hash` held constant
across both. So: **pin `hash`, never send `pcv`.**

**The one unsolved step is slug → content id.** The query keys on an internal numeric id
(`716378217`), not the URL slug we store; in a browser that id arrives inside the
challenge-solved HTML. This decides the shape of the whole block, so Q6a below is a **spike**,
not an implementation — three avenues, cheapest first:

1. **Find a path-keyed persisted operation.** One almost certainly exists (initial page load
   resolves path → content). Capture it as the above was captured: hook `window.fetch` +
   `XMLHttpRequest.open`, drive an SPA navigation, read back operation name + `hash`. The
   SPA-nav capture surfaced `ContentForLearnableContent`, `MappedStandardsForContent`,
   `feedbackQuery`, `getLastSecond`, `getOfficialClarifications`, `discussionAvatar` — the path
   resolver was *not* among them because it runs during initial load, so this needs a hook
   installed before page scripts (an `about:blank` iframe shim, or CDP-level capture).
2. **Grep the `cdn.kastatic.org` bundles** — fetchable server-side, and persisted hashes are
   usually embedded in them.
3. **One-time browser-harvested `slug → id` map** for the 879 rows, stored; the client then
   serves all future reads.

Whatever the source of ids, the client itself is small and LLM-free: zod-parse the response,
and treat any non-200 / schema mismatch / missing `duration` as **`unknown`, never as a
number** — a KA deploy that rotates hashes must degrade to unknown, not back to 20. Keep one
live integration test so rotation fails a test instead of silently filling the library with
unknowns.

**Articles and interactives have no API duration.** Articles: Perseus-body word count at
~120 wpm for math prose, +2 min for worked examples, `durationSource: 'extracted'`.
Interactive `/pi/` exercises expose **no measurable signal at all** — no runtime, no text body
(16 of 59 rows in the 2026-08-05 batch hit this) — and must record `unknown`.

**Already corrected by hand, do not redo:** 43 KA Cryptography rows on 2026-08-05 (26 videos
from exact player runtimes, 17 articles by word count), plus 11 OCW 6.0002 lectures and 7
6.045J decks. The 16 `/pi/` interactives in that container are still 20 and should be swept to
`unknown`.

Then **recompute container durations from children** (fixes the 22 arithmetic contradictions)
and stamp `durationSource` on every row. Rows that resist recovery get `unknown` — an honest
null beats a confident 20.

**Verification:** the 20m share drops from 59% toward the ~5% you would expect by chance;
no `book` under 30m; no container under half its children's sum; no `khanacademy.org` video row
left at exactly 20 with `durationSource != 'api'`. Note the `unknown` count is **reported, not
minimised** — a large honest unknown count is the success condition for P2's fixes 2–3, not a
regression.

## B5. Deprecate junk and dedupe

Two independent passes, both low-risk and doable any time:

- Deprecate the P6 furniture list (use `deprecationSeverity: soft` — these are quality
  downgrades, not dead links, so in-flight Tracks are unaffected).
- Dedupe: ~40 Khan pairs (ap-calculus-ab vs calculus-1 trees, the dup always `(review)`),
  9 Lamar CalcII/CalcIII twins, exact-duplicate `discrete-math-1-4-1-predicate-logic-7ok775`,
  two KA "Reference: Conditions for inference" articles, Khan SQL lesson pairs, two
  near-duplicate generated differential-equations on-ramps.

## B6. Backfill the 7 missing on-ramp memberships

Trivial once P5 lands; run `assertMembershipInvariants` across the whole table to confirm no
other writer has the same hole.

---

## Suggested block breakdown

Per `CLAUDE.md`: one feature per conversation, blocks under 300 LOC, one branch per block,
verification gate before commit. Schema-touching blocks must **stack** on the branch holding the
previous unmerged migration, and every generated `migration.sql` must have its regenerated
`DROP INDEX` lines for `Resource_embedding_idx` and `RemediationJob_active_per_path` deleted by
hand (`AGENTS.md`).

| block | scope | migration? |
| --- | --- | --- |
| Q1 | P1 — concept retry/bisect + `ConceptOrigin` + break vocab feedback loop | yes |
| Q2 | P2 — `durationSource`, drop `.default(20)` **and `manual.ts`'s `DEFAULT_DURATION_MIN`**, prompt calibration, upsert validation gate | yes (stack on Q1) |
| Q3 | B1 + B2 — concept repair driver + re-embed + centroid recompute | no |
| Q4 | P3 — classify children at ingest instead of inheriting | no |
| Q5 | B3 — whole-course parents by hand, then reclassify/quorum drivers | no |
| Q6a | B4 spike — resolve a KA URL to its content id server-side. **Findings note, not shipped code**; gates Q6b. Exit: a documented server-side slug→id route, or a decision to take the browser-harvested map | no |
| Q6b | B4 — `lib/sources/khan/` persisted-query client (pin `hash`, never send `pcv`, degrade to `unknown`), then the duration re-derivation driver + per-host adapters | no |
| Q7 | P4 + P5 + B6 — pool-aware guardrail, on-ramp filing seam, invariant assertion | no |
| Q8 | P6 + B5 — junk classifier at decomposition, deprecate + dedupe pass | no |

P7 (vocabulary) stays a discussion item and is deliberately not scheduled.

## Open questions for you

1. **P7** — merge `statistics` into `probability-and-statistics`, or formalize parent/child
   topic relations? This changes the warm-set and `TOPIC_RELATIONS`.
2. **Duration honesty vs. availability** — making `durationMin` nullable is the correct model.
   `attach-candidates.ts` is already null-safe (its `durationFactor` returns 1 on null and the
   `MAX_ATTACHABLE_DURATION_MIN` gate at :131 passes null), so the real decision point is
   `track/allocate.ts`, which sums `durationMin` as a non-null number for slice budgets. Treat
   `unknown` as "exclude" or "assume a type-median" there? I lean type-median with the
   `durationSource` recorded, so a null never silently drops a good resource.
3. **Scope of B1** — repair only the 306 exact parent-array matches, or the full 554-row
   shared-array set? The extra 248 include legitimate sharing and need spot-checking.
4. **Beta timing** — this is a lot of churn against a live free beta
   (`docs/plans/free-beta.md`). Land Part 1 first and let Part 2 run gradually?
5. **If Q6a finds no server-side slug→id route** — is a one-time browser-harvested id map an
   acceptable standing dependency, or should KA durations stay `unknown` until a reviewer
   touches them? 879 rows ride on this.
6. **Is pinning KA's `hash` in our source acceptable operationally?** It is a KA build
   artifact. The client degrades to `unknown` on rotation and the live test catches it, but
   someone has to re-capture. The alternative — no KA durations at all — is worse.
7. **Should `/review-pending-resources` block approval on `durationSource: 'unknown'`?** The
   queue is arguably exactly where unknowns should get resolved, but that makes every
   unmeasurable interactive a permanent queue resident.
