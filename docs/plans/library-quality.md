# Library quality plan — pipeline fixes + library backfill

**Status:** active — in progress · **Blocks:** Q1–Q10; #335–#340 open, Q6b at its gate
· **Block IDs:** `Q` · **Started:** 2026-08-05 · **Briefs retrofitted:** 2026-08-10
· **Q9 added** 2026-08-10 (open question 7) · **Q10 added** 2026-08-12 (Q6b's residue)

> **`P` and `B` are not block IDs.** `P1`–`P7` are pipeline *defects* and `B1`–`B6` are
> backfill *tasks* — the analysis this plan rests on. The implementable blocks are `Q1`–`Q8`,
> and each brief below names the P/B items it discharges. An earlier status header called
> P/B the block IDs; it was wrong.

Companion to `library-sanity-review.md` (the audit that motivated this).

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

`rung0-starvation.md` fixes a defect that looks adjacent and is not: the sourcing
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
| khanacademy.org | 879 (704 video, 139 article, 36 interactive) | ⚠️ **strategy replaced twice — see the Q6a findings below.** Videos resolve through the **official YouTube Data API** against Khan's own channel. Articles and interactives are not recoverable and record `unknown`. |
| tutorial.math.lamar.edu | 179 | Static HTML articles → deterministic reading-time from word count. No LLM. **Access re-verified 2026-08-11** (see Q6a findings). |
| ocw.mit.edu | 94 | Lecture notes/PDFs → page or word count; lecture videos → media duration. **Access re-verified 2026-08-11.** |
| everything else | ~26 | Hand-review. |

### The Khan Academy 879 — Q6a findings, 2026-08-11 (supersedes the persisted-query strategy)

**The persisted-query route is withdrawn, and not because it stopped working.** Its stated
rationale was that the GraphQL endpoint "answers the bot UA directly, bypassing the challenge
that walls HTML", and its fallback avenue was harvesting 879 ids through a real browser
precisely because non-browser clients are blocked. Both are circumvention of a bot-detection
system, so they are off the table regardless of whether they function.

**The finding that settles it:** `khanacademy.org/robots.txt` **itself returns the Client
Challenge** — HTTP 200, `<title>Client Challenge</title>`, no robots directives. The one file
whose purpose is to tell an automated client what it may do is unreadable by an automated
client. There is no permission to rely on here, and no way to obtain one by request.

**The replacement needs none of Khan's own infrastructure.** Khan Academy publishes its videos
on its own YouTube channel, and this repo already holds a `YOUTUBE_API_KEY` and a
`youtube/v3` client (`src/lib/agents/decomposition/youtube.ts`). Measured 2026-08-11:

```
channels?part=contentDetails&forHandle=khanacademy
→ channelId       UC4a-Gbdw7vOaccHmFo40b9g
  uploadsPlaylist UU4a-Gbdw7vOaccHmFo40b9g
  videoCount      9310

playlistItems?part=snippet&playlistId=UU4a-…&maxResults=50   → 1 quota unit per 50 videos
videos?part=contentDetails&id=<50 ids>                        → 1 quota unit per 50 videos
→ { "id": "0NjBjpGQpUQ", "duration": "PT12M26S" }
```

**Whole-channel cost is ~200 quota units** (187 pages + ~16 duration batches) against a
10,000/day default. Durations are exact, ISO-8601. The API is official and sanctioned, so
there is no `hash` to pin, no deploy version to track, and no rotation to catch — **plan open
questions 5 and 6 both dissolve** rather than being answered.

**What this route does and does not reach.** It covers the **755 KA video rows** (704 of them
at the placeholder 20) — the bulk of the problem. It reaches **neither the 139 articles nor
the 36 interactives**, which are not on YouTube and whose page text is behind the same wall.
Those record `unknown` and wait for a reviewer, which is what **Q9** exists for. Sweeping 175
rows to an honest `unknown` is the correct outcome here, not a shortfall — see B4's closing
note that the unknown count is reported, not minimised.

**The residual risk is matching, not access.** YouTube titles carry breadcrumbs
(`"One-time pad | Journey into cryptography | Computer Science | Khan Academy"`) where we
store the lesson title. Normalising on the segment before the first `|` is the obvious rule,
but **an ambiguous or missing match must record `unknown`, never a guess** — the same
degradation contract the withdrawn client had.

### Lamar and OCW access, re-verified 2026-08-11

The Khan finding made the plan's "both scrape fine" claim worth re-testing. Both hold:

| host | robots.txt | our rows | live fetch with the crawler UA |
| --- | --- | --- | --- |
| `tutorial.math.lamar.edu` | readable; `Disallow:` covers **only** `/pdf/…` trees | all 215 are `/Classes/` HTML, zero under `/pdf/` | `200`, 106 KB |
| `ocw.mit.edu` | readable; `User-Agent: *` / `Allow: /` + sitemap | 94 | `200`, 50 KB |

So Khan is the only host in this plan that refuses automated clients, and the per-host
estimators for Lamar and OCW rest on verified ground rather than assumption.

**Articles and interactives have no API duration.** Articles: Perseus-body word count at
~120 wpm for math prose, +2 min for worked examples, `durationSource: 'extracted'`.
Interactive `/pi/` exercises expose **no measurable signal at all** — no runtime, no text body
(16 of 59 rows in the 2026-08-05 batch hit this) — and must record `unknown`.

**Already corrected by hand, do not redo:** 43 KA Cryptography rows on 2026-08-05 (26 videos
from exact player runtimes, 17 articles by word count), plus 11 OCW 6.0002 lectures and 7
6.045J decks. The 16 `/pi/` interactives in that container are still 20 and should be swept to
`unknown`.

> ⚠️ **This claim was not true of the dev DB, measured 2026-08-12 during Q6b.** Every row of
> that named cohort was sitting at the placeholder 20 immediately before Q6b ran — including
> this plan's own worked example, *"Frequency stability property short film at 2:09 stored as
> 20 minutes"*, which Q6b then independently recomputed to 2 minutes from the YouTube API.
> Either the corrections were made against **production** and the dev DB never had them, or
> the dev DB was reset since. Two agents spent real effort hunting for rows that were not
> there, so: **treat this paragraph as true of production only, and verify before relying on
> it.** The protection that actually matters is structural, not a list — a hand-set duration
> is not 20, so a `durationMin = 20` selector cannot see it. That holds on any database.

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

# Blocks

Nine blocks — the original eight, plus **Q9**, added 2026-08-10 when open question 7 was
resolved. Q1 and Q2 both carry migrations and therefore **stack**; Q3 onward branch off
whichever migration branch precedes them until the chain merges. Every generated
`migration.sql` must have its regenerated `DROP INDEX` lines for `Resource_embedding_idx` and
`RemediationJob_active_per_path` deleted by hand — read `.claude/rules/prisma-migrations.md`
before running `prisma migrate dev` (`AGENTS.md`).

Several blocks are **drivers**, not features: they run once against a database and their
acceptance criteria are measured row counts, not rendered behaviour. Those criteria are
written against the **dev DB** unless they say production, and `block-verifier` will mark
production-only ones `untested` — which is correct, not a gap.

**P7 (vocabulary) is deliberately unscheduled** — it is open question 1, and it changes
`TOPIC_RELATIONS` and the warm-set, so it is not a block until the user settles it.

| block | discharges | migration | ~LOC |
| --- | --- | --- | --- |
| Q1 | P1 | yes | ~250 |
| Q2 | P2 | yes (stacks on Q1) | ~280 |
| Q3 | B1 + B2 | no | ~200 |
| Q4 | P3 | no | ~180 |
| Q5 | B3 | no | ~220 |
| Q6a | B4 spike | no | ~0 (findings note) |
| Q6b | B4 | no | ~290 |
| Q7 | P4 + P5 + B6 | no | ~240 |
| Q8 | P6 + B5 | no | ~260 |
| Q9 | open question 7 | no | ~200 |
| Q10 | the standing unknowns | no | ~250 |

## Q1 — concept provenance, retry/bisect, and breaking the vocab loop (~250 LOC)

Discharges **P1**.

**Base branch:** `main`
**Files owned:**
- `prisma/schema.prisma` (+ migration — `ConceptOrigin` enum + column on `Resource`)
- `src/lib/agents/decomposition/concepts.ts` (retry/bisect, `loadTopicVocab` exclusion)
- `src/lib/agents/decomposition/doctoc.ts` (stamp at :253 **and** the unconditional :238 sub-container path)
- `src/lib/agents/decomposition/manual.ts` (stamp at :64)
- `src/lib/agents/decomposition/youtube.ts` (stamp at :114)
- `src/lib/agents/decomposition/concepts.test.ts`

**What it does.** Makes a failed concept derivation impossible to mistake for a successful
one. Adds `ConceptOrigin` (`derived` | `inherited` | `fallback`) to `Resource`, mirroring the
`TopicFilingOrigin` precedent. `deriveBatch` retries a failed batch once and then bisects it —
a 25-item batch usually fails because one malformed item poisons the object parse, so
splitting recovers the other 24. Whatever still fails writes the parent array **stamped
`inherited`**, and the `[topic]` last resort is stamped `fallback`. `loadTopicVocab` stops
grounding future derivations on non-`derived` concepts, which is what breaks the
contamination feedback loop.

**Out of scope.** Repairing the 306 existing rows — that is Q3, and it depends on this
block's retry/bisect being in place. Topic classification (Q4).

**Migration:** yes — new enum + non-null column with a default. Existing rows cannot be
truthfully stamped by the migration; back-filling their real origin is Q3's job. Use a default
that does not assert success. `DROP INDEX` rule above applies.

**New deps:** none

**Tests.** `concepts.test.ts` (unit, pure) — bisect arithmetic, origin selection per path,
`loadTopicVocab` filtering. The four call sites are covered by asserting the stamp each one
passes, not by re-testing derivation.

**Acceptance criteria.**
- [ ] A batch whose `generateObject` call throws is retried once, then split; with one
      poisoned item in 25, the other 24 come back `derived`.
- [ ] A derivation that fails after bisecting writes the parent array with
      `conceptOrigin: 'inherited'` — never with `derived`.
- [ ] The `doctoc.ts:238` sub-container path, where derivation is never attempted, stamps
      `inherited` too.
- [ ] The `[topic]` last-resort fallback stamps `fallback`, distinguishable from `inherited`.
- [ ] `loadTopicVocab` returns no concepts from rows whose origin is `inherited` or
      `fallback`.
- [ ] A derivation failure emits a `logWarn`/`logError` line through `@/lib/log` — the
      existing `console.log` is gone (CLAUDE.md logging rule).
- [ ] All four call sites (`doctoc.ts:253`, `:238`, `manual.ts:64`, `youtube.ts:114`) pass an
      explicit origin; none relies on the column default.

## Q2 — duration provenance and calibration (~280 LOC)

Discharges **P2**.

**Base branch:** `Q1`'s branch (stacked — second migration)
**Files owned:**
- `prisma/schema.prisma` (+ migration — `durationSource` enum + nullable `durationMin`)
- `src/lib/agents/tools/web-fallback.ts` (schema at :58, prompt guidance at :751)
- `src/lib/agents/decomposition/doctoc.ts` (remove `.default(20)` at :79)
- `src/lib/agents/decomposition/manual.ts` (delete `DEFAULT_DURATION_MIN` at :23, make `durationMin` optional on `ManualChildInput`, fix the header comment)
- `src/lib/agents/decomposition/upsert-resource.ts` (the validation gate)
- `src/lib/agents/track/allocate.ts` (null handling — see open question 2)
- colocated tests for the gate and the null-duration path

**What it does.** Stops encoding "we don't know" as a number that looks measured. Adds
`durationSource` (`api` | `extracted` | `estimated` | `unknown`) and makes `durationMin`
nullable. Removes both hardcoded fills — `doctoc.ts`'s `.default(20)` and `manual.ts`'s
`DEFAULT_DURATION_MIN`, the library's single largest source of placeholder durations. Gives
the extraction prompt per-type ranges, an instruction to read a duration off **link text or
the parent TOC** (never "the page" — doc-TOC never fetches child pages), and explicit
permission to return null, which per Cause B is the half that actually moves the number. Adds
an upsert validation gate rejecting a `book` or multi-unit `course` under 30 minutes and any
atomic leaf over `MAX_ATTACHABLE_DURATION_MIN`.

**Out of scope.** Re-deriving the 1,177 existing placeholder rows (Q6b). Fetching child pages
to measure them — explicitly deferred in P2 fix 3 as its own sizing exercise. Container/child
duration reconciliation is a *write-path* rule here; the one-time repair of the 22 existing
contradictions belongs to Q6b.

**Migration:** yes — `durationMin` becomes nullable and `durationSource` is added. Nullable
widening is safe; the risk is downstream non-null assumptions, which is why
`track/allocate.ts` is in this block's files. `DROP INDEX` rule above applies.

**New deps:** none

**Tests.** Unit, pure: the validation gate's accept/reject table per `type`; the null-duration
path through `allocate.ts`'s slice budget; prompt assembly containing the ranges and the null
permission.

**Acceptance criteria.**
- [ ] `durationMin` is nullable in the schema and `durationSource` is non-null on every write
      path.
- [ ] Neither `doctoc.ts` nor `manual.ts` contains a hardcoded duration constant; a supplier
      that provides no duration produces `null` + `unknown`, not `20`.
- [ ] `manual.ts`'s header comment no longer advertises the default as intentional parity
      with doc-TOC.
- [ ] The upsert gate rejects a `book` at 20 minutes and an atomic leaf above
      `MAX_ATTACHABLE_DURATION_MIN`; it accepts a `book` at 400.
- [ ] The extraction prompt contains per-type ranges, the link-text/TOC instruction, and
      explicit permission to return null.
- [ ] `track/allocate.ts` handles a null `durationMin` per the resolution of open question 2
      — no `NaN` reaches a slice budget, and the behaviour is asserted by a test.
- [ ] `attach-candidates.ts` still passes a null-duration candidate through its
      `durationFactor` and its `MAX_ATTACHABLE_DURATION_MIN` gate (this was already null-safe;
      the criterion guards against a regression).

## Q3 — repair contaminated concepts, re-embed, recompute centroids (~200 LOC)

Discharges **B1 + B2**. Driver block.

**Base branch:** `Q2`'s branch (needs Q1's retry/bisect in the code path)
**Files owned:**
- `scripts/repair-concepts.ts` (new)
- `src/lib/curation/concept-repair.ts` (new — pure selection + stamping logic)
- `src/lib/curation/concept-repair.test.ts` (new)

**What it does.** Re-runs `deriveChildConcepts` for the ~306 children whose concept array
exactly equals their parent's, with Q1's retry/bisect in place, and stamps `ConceptOrigin` on
every row touched. Then re-embeds — `scripts/embed-resources.ts` already re-embeds where
`embeddedAt < updatedAt`, so the repair's writes make the rows self-selecting — and recomputes
`TopicCentroid`, which is a mean over exactly those vectors and is stale the moment the repair
lands.

**Out of scope.** The wider 554-row shared-array set: some sharing is legitimate (a genuine
4-part series on one concept), so it needs spot-checking first. That is open question 3, and
the script should support it behind a flag without running it.

**Migration:** none
**New deps:** none

**Tests.** `concept-repair.test.ts` (unit, pure — the exact-match predicate, the
contiguous-`orderInParent`-run detector, stamping). The driver run itself is verified by the
acceptance criteria below against the dev DB.

**Acceptance criteria.**
- [ ] After the run, zero children carry a concept array exactly equal to their parent's
      without an `inherited` stamp.
- [ ] No contiguous 25-aligned `orderInParent` runs of identical concept arrays remain.
- [ ] Every row the driver touched has a non-default `conceptOrigin`.
- [ ] Every repaired row has `embeddedAt >= updatedAt` after the re-embed step.
- [ ] `TopicCentroid` rows are recomputed after the re-embed, not before.
- [ ] The driver is idempotent: a second run reports zero rows to repair.
- [ ] The driver refuses to run against production without an explicit flag (the guard
      pattern from `scripts/reset-content.ts`).

## Q4 — classify decomposed children instead of inheriting (~180 LOC)

Discharges **P3**.

**Base branch:** `Q3`'s branch (ordering constraint: the classifier reads embeddings built over `conceptsTaught`, so Q1 + Q3 must precede it)
**Files owned:**
- `src/lib/agents/decomposition/upsert-resource.ts` (the filing call at child creation)
- `src/lib/agents/tools/classify-topic.ts` (accepting the parent topic as a prior)
- colocated tests

**What it does.** Files a decomposed child on its own content at ingest, gated by the existing
T2b guardrail, instead of inheriting the parent's topic. The parent's topic becomes a prior,
not an answer. This is the fix for the pattern where every topic a reviewer called a dumping
ground is inherited-filed and every classifier-filed topic came back clean.

**Out of scope.** Reclassifying the 775 existing `inherited` memberships (Q5). Changing the
guardrail's thin-shelf behaviour (Q7).

**Migration:** none
**New deps:** none

**Tests.** Unit, pure — the prior is applied as a tiebreak and does not override a confident
classification; the guardrail still abstains where it did before.

**Acceptance criteria.**
- [ ] A newly decomposed child whose content clearly belongs to a different topic than its
      parent is filed on its own topic, with `origin` recorded as a classifier filing rather
      than `inherited`.
- [ ] A child the classifier cannot place confidently still gets a membership, marked so the
      uncertainty is visible — it is not dropped.
- [ ] The parent topic influences but never overrides a confident classification.
- [ ] Newly created children no longer produce `origin: 'inherited'` rows on the happy path;
      a decomposition run over a fixture container yields zero.
- [ ] `assertMembershipInvariants` (`src/lib/curation/resource-topics.ts:331`) passes after a
      decomposition run.

## Q5 — reclassify the 775 inherited memberships (~220 LOC)

Discharges **B3**. Driver block.

**Base branch:** `Q4`'s branch
**Files owned:**
- `scripts/reclassify-topics.ts` (extend — it exists for exactly this backlog)
- `scripts/refile-quorum-topics.ts` (extend — cohort mode)
- `src/lib/curation/quorum-refile.ts` (if cohort handling needs pure logic)
- colocated tests

**What it does.** Works the inherited-membership backlog, whole-course parents first — their
children reclassify onto the correct shelf for free. The eight cohorts are listed in B3 above
(Lamar Differential Equations, Lamar Calculus III, MIT 18.781, Khan cryptography, and the
rest). Several target shelves (`number-theory` 14, `graph-theory` 9,
`differential-equations` 11) sit below `MIN_VOUCHABLE_POOL`, which is precisely the deadlock
`refile-quorum-topics.ts` was written to break — so these route through it as a cohort, not
row by row.

**Out of scope.** Changing what `reclassify-topics.ts` fundamentally does. Two constraints
from its header are load-bearing and must survive this block: it **never refiles**, it records
doubt; moving primaries is `refile-quorum-topics.ts`'s job.

**Migration:** none
**New deps:** none

**Tests.** Unit, pure — cohort grouping, the below-`MIN_VOUCHABLE_POOL` routing decision.

**Acceptance criteria.**
- [ ] `reclassify-topics.ts` still never moves a primary — a run leaves every
      `ResourceTopic.isPrimary` row's topic unchanged.
- [ ] The eight named cohorts are refiled onto their stated target shelves.
- [ ] Cohorts whose target shelf is below `MIN_VOUCHABLE_POOL` go through the quorum path and
      are not blocked by the thin-shelf deadlock.
- [ ] The count of `origin: 'inherited'` memberships drops materially from 775, and the
      remainder is reported rather than silently left.
- [ ] `assertMembershipInvariants` passes across the whole table afterwards.
- [ ] **Documented in the block's report:** the compose workers were stopped before the run
      (`docker compose --profile workers stop worker`) and restarted with `--build` after.

## Q6a — spike: how to obtain Khan Academy durations (~0 LOC) — **DONE 2026-08-11**

Discharges the **B4** blocker. **A findings note, not shipped code.** Gated Q6b.

**Base branch:** `Q5`'s branch
**Files owned:** `docs/plans/library-quality.md` (the findings section in B4) — no source files.

**What it did.** The spike's original question — "resolve a Khan URL to its internal content
id server-side" — turned out to be the wrong question. `robots.txt` is itself behind Khan's
bot wall, so the persisted-query route and its browser-harvest fallback are both
bot-detection circumvention and were withdrawn on that basis, not on feasibility. The
replacement uses the **official YouTube Data API** against Khan's own channel and touches none
of Khan's infrastructure. Full findings, measured numbers and the Lamar/OCW re-verification
are in the B4 section above.

**Out of scope.** Writing the client. Touching the library. This block shipped a decision.

**Migration:** none
**New deps:** none
**Tests.** none — there is no code.

**Acceptance criteria.**
- [x] The findings section names a working route — the YouTube Data API against channel
      `UC4a-Gbdw7vOaccHmFo40b9g` — **or** records that none was found. *(A route was found,
      and it is not the one the plan anticipated.)*
- [x] The route is reproducible from the note by someone who was not in the conversation —
      the exact endpoints, the channel and uploads-playlist ids, and the measured quota cost
      are all recorded.
- [x] ~~The `hash` parameter's stability and `pcv`'s irrelevance are re-confirmed~~ —
      **moot.** The chosen route has no `hash` and no `pcv`.
- [x] The user has answered open question 5 before Q6b starts — **dissolved rather than
      answered**: no harvested id map is needed. Settled 2026-08-11 along with question 6.

## Q6b — Khan YouTube matcher and the duration re-derivation drivers (~290 LOC)

Discharges **B4**. Driver block. **Rewritten 2026-08-11 on Q6a's findings** — the Khan
persisted-query client is gone; see the B4 findings section for why.

**Base branch:** `Q6a`'s branch
**Files owned:**
- `src/lib/sources/khan/youtube-index.ts` (new — build and query the channel index)
- `src/lib/sources/khan/youtube-index.test.ts`, `youtube-index.int.test.ts` (new)
- `scripts/rederive-durations.ts` (new — driver + per-host adapters)
- `src/lib/curation/duration-estimate.ts` (new — pure per-host estimators)
- `src/lib/curation/duration-estimate.test.ts` (new)

**What it does.** Enumerates Khan Academy's YouTube uploads playlist
(`UU4a-Gbdw7vOaccHmFo40b9g`, ~9,310 videos, ~200 quota units for the whole channel) through
the **official** Data API, builds a normalised `title → {videoId, durationSeconds}` index, and
matches our 755 KA video rows against it. Reuse the existing `youtube/v3` client and
`YOUTUBE_API_KEY` rather than adding a second one. Then the other hosts: Lamar's 179 static
HTML articles take deterministic reading time from word count, OCW's 94 take page/word count
or media duration — **both hosts' access re-verified 2026-08-11**, see B4. Finally container
durations are recomputed from children, fixing the 22 arithmetic contradictions.

**Title matching is the risk surface, and it degrades one way.** YouTube titles carry
breadcrumbs (`"One-time pad | Journey into cryptography | … | Khan Academy"`); the segment
before the first `|` is the lesson title. **An ambiguous match, a missing match, or a
duplicate title must record `unknown` — never a guess, never 20.**

**Out of scope.** **Khan articles (139) and interactives (36) — no route reaches them.** They
are not on YouTube and their page text is behind the bot wall, so they record `unknown` and
wait for a reviewer (Q9). This is the intended outcome, not a shortfall. Also out: the ~26
"everything else" rows (hand review), and the 43 KA Cryptography rows, 11 OCW 6.0002 lectures
and 7 6.045J decks already corrected by hand on 2026-08-05, which must **not** be redone.
**Anything that touches `khanacademy.org` directly** — the whole point of Q6a's finding.

**Migration:** none — Q2 added the columns.
**New deps:** none

**Tests.** `duration-estimate.test.ts` (unit, pure — word-count estimators per host, the
container-sum reconciliation, ISO-8601 duration parsing). `youtube-index.test.ts` (unit —
title normalisation, and the degrade-to-`unknown` path on every ambiguity shape: no match,
multiple matches, empty index). **One live integration test** against the real Data API, so a
channel rename or a quota failure fails a test rather than silently filling the library with
unknowns.

**Acceptance criteria.**
- [ ] No request is made to any `khanacademy.org` or `kastatic.org` host by this block's code.
- [ ] Any non-200, quota error, missing match, ambiguous match or duplicate title yields
      `unknown` — never a number, and never a fallback to 20.
- [ ] A known Khan video resolves to its exact duration from the Data API.
- [ ] The live integration test fails, loudly, if the channel or uploads playlist stops
      resolving.
- [ ] The 20-minute share of the library drops from 59% toward the ~5% expected by chance.
- [ ] No `khanacademy.org` **video** row remains at exactly 20 with `durationSource != 'api'`.
- [ ] Khan **article and interactive** rows are `unknown`, not estimated — no route reaches
      them and guessing is the failure mode this plan exists to remove.
- [ ] No `book` under 30 minutes, and no container under half its children's summed duration,
      remains.
- [ ] Every row the driver touched carries a `durationSource`.
- [ ] The rows hand-corrected on 2026-08-05 are unchanged by the run.
- [ ] **The `unknown` count is reported, not minimised.** A large honest unknown count is the
      success condition for Q2, not a regression — a run that drove unknowns toward zero by
      guessing has failed this block. With articles and interactives now structurally
      unreachable, expect **at least 175** and do not treat that as a defect.

## Q7 — pool-aware guardrail, on-ramp filing seam, invariant (~240 LOC)

Discharges **P4 + P5 + B6**.

**Base branch:** `Q6b`'s branch
**Files owned:**
- `src/lib/curation/topic-centroids.ts` (pool-size-aware abstention)
- `src/lib/curation/topic-knn.ts` (the k-NN side of the same decision)
- `src/lib/curation/resource-topics.ts` (the new invariant in `assertMembershipInvariants`)
- the on-ramp creation path (route it through `setPrimaryTopic` at `resource-topics.ts:53`)
- colocated tests

**What it does.** Makes the filing guardrail abstain on a thin shelf rather than contest,
which is the same failure `review-drain.ts:101` already reasons about ("the fix is a fallback,
NOT a lower `MIN_CENTROID_MEMBERS`"). All 42 contested rows sit in the four thinnest topics and
most are correctly filed — an 8-member shelf simply cannot outvote calculus's 479. Also routes
generated on-ramp creation through the `setPrimaryTopic` seam like every other writer, and
adds an invariant so a resource with a scalar `topic` and zero memberships is a detected error
rather than an invisible one.

### Added to Q7 on 2026-08-11: promote `database-systems` to the curated vocabulary

Q5's reclassification pass surfaced three mint channels: `database-systems` **15 rows —
clears quorum**, `reinforcement-learning` 3, `nosql` 1. The user settled the scope on
2026-08-11: **promote `database-systems` only.** The other two sit far below
`MIN_VOUCHABLE_POOL` (10); promoting them would create curated shelves that cannot vouch for a
filing, which is the exact pathology the rest of this block fixes. They mint naturally when
they reach quorum.

**The distinction this rests on, because it is easy to get wrong.** A shelf *existing* and a
shelf being *curated* are different things, and the library already leans hard on the
difference — measured 2026-08-11, **23 shelves are live but `TOPIC_SLUGS` names 13**, two of
which (`go`, `javascript`) hold zero rows. Twelve live shelves are agent-minted and
unpromoted, including `probability-and-statistics` at 206 primaries — the second-largest shelf
in the library. Minting already works without code changes (T3, `createTopicMinter` →
`validateTopic`); that is how `differential-equations` was born during Q5. So this addition is
**not** about letting the rows land somewhere. It is about `TOPIC_SLUGS` membership, which per
that list's own comment is what makes a topic first-class: the topic gate fast-accepts it
without an LLM call, the planner and registry canonical lists union it, and **the free-beta
warm set is this list minus `go`**. The learner-facing half is the reason to do it — a tech
upskiller would plausibly type "database systems" into the box and should get a warm shelf,
not a cold mint.

**The `TOPIC_RELATIONS` edge must be measured, not assumed.** The 15 rows came off `sql` (117
primaries), so the two shelves are adjacent. `TOPIC_RELATIONS`'s header is explicit that
directions are justified on **retrieval** grounds and that attachment archaeology alone is not
sufficient evidence about a shelf populated after a Path was built — which is exactly this
shelf's situation. The working hypothesis is `sql: ['database-systems']` without the reverse
(a SQL learner benefits from normalization and crash recovery; a database-systems learner does
not necessarily want SQL syntax tutorials), and `scripts/verify-topic-narrowing.ts` is the
instrument that settles it.

**This is a deliberate partial answer to P7 / open question 1** — it promotes one topic
without settling the `statistics` / `probability-and-statistics` merge or the parent/child
relation question. It is safe to take separately because `database-systems` is not a subtopic
of an existing shelf; the P7 cases that stay open all are.

**Additional files owned:** `src/types/resource.ts` (`TopicSlug`, `TOPIC_SLUGS`,
`TOPIC_RELATIONS`), plus a refile of the 15 waiting rows through the existing
`refile-quorum-topics.ts` cohort mode Q5 built.

**Out of scope.** Lowering `MIN_CENTROID_MEMBERS` — explicitly the wrong fix. The rest of P7's
vocabulary question: the `statistics` / `probability-and-statistics` merge, the parent/child
topic relation, and promoting any of the other eleven unpromoted shelves. Promoting
`reinforcement-learning` or `nosql`.

**Migration:** none
**New deps:** none

**Tests.** Unit, pure — abstain-vs-contest across pool sizes either side of
`MIN_CENTROID_MEMBERS`; the new invariant's detection.

**Acceptance criteria.**
- [ ] A resource filed against a shelf below `MIN_CENTROID_MEMBERS` abstains rather than
      recording `contested`.
- [ ] `MIN_CENTROID_MEMBERS` is unchanged at 20 (`topic-centroids.ts:35`).
- [ ] The 41-of-42 contested primaries are not orphaned by the change — no resource loses its
      primary membership.
- [ ] A generated on-ramp created through the normal path has a `ResourceTopic` row; creating
      one no longer bypasses `setPrimaryTopic`.
- [ ] `assertMembershipInvariants` fails when given a resource with a scalar `topic` and zero
      memberships, and the 7 known on-ramp holes are backfilled to zero.
- [ ] A whole-table invariant run reports no other writer with the same hole.
- [ ] `database-systems` is in `TopicSlug` and `TOPIC_SLUGS`, and the topic gate fast-accepts
      it without an LLM call.
- [ ] The 15 waiting rows are filed on `database-systems`, and the shelf clears
      `MIN_VOUCHABLE_POOL`.
- [ ] Any `TOPIC_RELATIONS` edge added between `sql` and `database-systems` is **directed** and
      backed by a `scripts/verify-topic-narrowing.ts` measurement quoted in the block's report
      — or no edge is added and the report says the measurement did not support one.
- [ ] `reinforcement-learning` and `nosql` are **not** promoted.
- [ ] **The 130 rows Q5's cohort refile moved are re-scored** once the guardrail is
      pool-aware, and the report gives the before/after contested count. 52 of the 130 (40%)
      came out `contested` — see the measurement in the P7 note under open question 1. The
      moves are correct curation; the stamps record a disagreement with evidence that could
      not express a subtopic relation. A re-score that leaves them all contested is a **valid
      outcome** to report, not a failure — what is not acceptable is leaving them unexamined.

## Q8 — junk classifier, deprecation and dedupe (~260 LOC)

Discharges **P6 + B5**.

**Base branch:** `Q7`'s branch
**Files owned:**
- `src/lib/curation/non-teaching.ts` (new — the classifier)
- `src/lib/curation/non-teaching.test.ts` (new)
- `src/lib/agents/decomposition/upsert-resource.ts` (call it at decomposition)
- `scripts/deprecate-furniture.ts`, `scripts/dedupe-resources.ts` (new)

**What it does.** Stops container furniture entering as teachable leaves — `about-the-course`,
`course-prerequisites`, Khan `Feedback`/`Checkpoint`/`what-s-next`, docs front-matter — with a
cheap title/summary heuristic plus the existing junk-leaf signal (low absolute centroid
similarity, which the schema notes "doubles as a decent junk-leaf detector"). Then two
one-time passes: deprecate the P6 furniture list at `deprecationSeverity: soft`, and dedupe
the known pairs (~40 Khan ap-calculus-ab/calculus-1 twins where the dup is always `(review)`,
9 Lamar CalcII/CalcIII twins, and the rest listed in B5).

**Out of scope.** Hard deprecation — these are quality downgrades, not dead links, and
in-flight Tracks must be unaffected. Any dedupe pair not enumerated in B5.

**Migration:** none
**New deps:** none

**Tests.** `non-teaching.test.ts` (unit, pure) — the heuristic over a fixture set of real
furniture titles and real lesson titles, asserting no false positive on the lesson titles.
False positives matter more than misses here: wrongly deprecating a real lesson removes it
from every learner's retrieval.

**Acceptance criteria.**
- [ ] The classifier flags every title in the P6 furniture list.
- [ ] It flags none of a fixture set of genuine lesson titles — zero false positives is the
      bar for this block.
- [ ] Furniture admitted during a fresh decomposition run is not created as an atomic
      pickable leaf.
- [ ] The deprecation pass writes `deprecationSeverity: 'soft'` only; no row becomes `hard`.
- [ ] No built Track changes as a result of the deprecation pass (Tracks are immutable —
      the invariant `pending-review.ts` states).
- [ ] Each deduped pair leaves exactly one active row, and the survivor is the non-`(review)`
      one for the Khan pairs.
- [ ] Both drivers are idempotent and refuse to run against production without an explicit
      flag.

## Q9 — the review queue as the provenance gate (~200 LOC)

Resolves **open question 7**, in the direction the user settled 2026-08-10: the queue does
**not** block approval on `durationSource: 'unknown'` — it makes the unknown visible and gives
the reviewer the authority to resolve it. Added after Q2 shipped, not part of the original
eight.

**Base branch:** `Q8`'s branch

**The reasoning.** `/review-pending-resources` is the final gate, and a reviewer working it has
the rendered page open — the one context where the true duration and the true topic are free.
`resource-update-schema.ts`'s own header already states this rationale for `durationMin`
("the reviewer already has the page open, so it corrects the guess against observed reality").
Once a resource passes the gate, its properties should be as close to verified as we can make
them. Blocking on `unknown` would instead make every unmeasurable `/pi/` interactive a
permanent queue resident.

**What it does.**
1. Surface provenance in the queue: `durationSource` and the row's topic-filing origin
   (`ResourceTopic.origin` + `relevance`), so a reviewer can see which fields are unverified
   rather than guessing which numbers to trust.
2. A reviewer-supplied duration stamps a **reviewer-authoritative** `durationSource` — today a
   hand-measured value would be written and still read `unknown`, which is the same
   indistinguishability defect Q2 exists to remove. Decide whether that is `extracted` or a new
   enum member; a new member is the honest answer if we want to tell a reviewer's measurement
   apart from a scraper's.
3. The same for topic. Note `topic` is **deliberately outside** `resourceUpdateSchema`'s
   whitelist — the header explains why — so this is a filing-aware seam through
   `setPrimaryTopic`, not a field added to the metadata-edit whitelist.

**Out of scope.** Blocking approval on any provenance value. Re-deriving anything in bulk
(Q6b). Changing what the queue approves.

**Why after Q7, not after Q2.** Topic-filing origins change twice underneath this block —
Q4 files decomposed children on their own content, Q7 makes a thin shelf abstain rather than
contest. Building the reviewer's topic seam last means writing it against the final origin
model instead of one that shifts under it.

**Migration:** only if a new `DurationSource` member is chosen in (2).
**New deps:** none

**Acceptance criteria.**
- [ ] The pending-review queue displays `durationSource` and the topic-filing origin for every
      row a reviewer sees.
- [ ] A reviewer-corrected duration is persisted with a source that is distinguishable from
      both `unknown` and a scraper-derived value.
- [ ] A reviewer can correct a row's topic, and the correction routes through `setPrimaryTopic`
      rather than writing `Resource.topic` directly.
- [ ] `assertMembershipInvariants` passes after a reviewer topic correction.
- [ ] Approval is **not** blocked on `durationSource: 'unknown'` — a `/pi/` interactive with no
      measurable signal can still be approved.

## Q10 — resolve the standing unknowns (~250 LOC)

Added 2026-08-12, after Q6b measured what it could not reach. **Not part of the original
eight, and not a defect in any block** — every block behaved as specified. The gap is that
"record `unknown` honestly" was specified everywhere and "resolve the unknowns" was specified
nowhere except Q9, which only sees the review queue.

**Base branch:** `Q9`'s branch

### The two populations, measured on the dev DB 2026-08-12 (post-Q6b)

Q9 reaches `pending_review` rows. **452 of the 508 null-duration rows are `active`** — already
approved, never returning to the queue — so Q9 reaches about 11% of the problem.

**Population A — 452 active rows with no duration at all:**

| host | type | rows | reachable? |
| --- | --- | --- | --- |
| khanacademy | video | **299** | **yes — title-normalisation misses against an index we already cache** |
| khanacademy | article | 122 | no route (bot wall) |
| khanacademy | interactive | 19 | no measurable signal at all |
| ocw | book | 8 | probably — page count |
| lamar | article | 3 | probably — word count |
| other | book | 1 | hand review |

The 299 are **not** in the same class as the 141 articles/interactives, and Q6b's out-of-scope
list blurred them together. Those 141 are structurally unreachable; the 299 merely failed a
string comparison.

**Population B — 794 active rows carrying a number with `durationSource: 'unknown'`.** This is
Q2's defect inverted: a value that *was* measured — sometimes by a human — presented as
unmeasured. Two sources feed it: legacy pipeline durations that Q2's migration defaulted, and
every reviewer correction, because `updateResource()`'s field whitelist
(`src/lib/curation/update-resource.ts`) includes `durationMin` but **not** `durationSource`.
Q9 fixes that write path going forward; it does nothing for the 794 already there.

### What this block does

1. **A second Khan matching pass for the 299, with a confirmation step** — settled by the user
   2026-08-12. The stored URL slug also keys the cached index and would resolve most of them,
   but Q6b measured it **~4% confidently wrong** (8 of 233 rows where both keys resolved
   uniquely disagreed, e.g. `Introduction to matrices` 711s vs 269s — different videos). A key
   that wrong cannot write unattended. Two safe ways to use it, and the block should implement
   whichever is cheaper to review: **require title-key and slug-key agreement** (silent, safe,
   recovers only the overlap), or **route slug-key-only matches through reviewer confirmation**
   (recovers more, costs reviewer time). Reject fuzzy/edit-distance matching outright — it
   manufactures exactly the confident-wrong values this plan exists to remove.
2. **A provenance backfill for the 794.** Where a row's number can be attributed
   (a YouTube-sourced video, a reviewer edit identifiable in the audit record), stamp it. Where
   it cannot, **leave it `unknown` and report the count** — the same rule as everywhere else in
   this plan. This pass must not invent provenance to make a number look better than it is.
3. **The residual OCW/Lamar rows** (8 books, 3 articles) via the estimators Q6b already built.

**Out of scope.** The 141 Khan articles and interactives — genuinely unreachable, and Q9's
reviewer surface is their only path. Any fetch to `khanacademy.org` or `kastatic.org` (Q6a).
Re-deriving anything Q6b already stamped with a real source.

**Migration:** none
**New deps:** none

**Tests.** Unit, pure — the agreement predicate between the two keys, and the attribution rules
for the provenance backfill including the "cannot attribute → stay unknown" path.

**Acceptance criteria.**
- [ ] No slug-key match is written unattended: either it agreed with the title key, or a
      reviewer confirmed it.
- [ ] Fuzzy or edit-distance title matching is **not** used.
- [ ] The 299 Khan video misses are reported as recovered / still-unknown / awaiting
      confirmation, with counts.
- [ ] No row gains a `durationSource` the evidence does not support — an unattributable number
      stays `unknown`, and that count is reported.
- [ ] The 141 Khan article/interactive rows are untouched.
- [ ] Idempotent, and refuses to run against production without an explicit flag.
- [ ] The block's report states the remaining unknown count **and does not treat it as a
      failure** — the standing rule from B4.

## Open questions for you

1. **P7** — merge `statistics` into `probability-and-statistics`, or formalize parent/child
   topic relations? This changes the warm-set and `TOPIC_RELATIONS`. **Partially answered
   2026-08-11**: `database-systems` is being promoted to `TOPIC_SLUGS` in Q7 (see the section
   added to that brief). That case was separable because it is not a subtopic of an existing
   shelf. The merge and the parent/child relation are still **OPEN**, and so is the larger
   question the promotion exposed: **eleven other live shelves are unpromoted, including
   `probability-and-statistics` at 206 primaries.** The split between curated and minted looks
   accidental rather than designed, and deciding it one shelf at a time is how it got this way.

   **Hard evidence that P7 is not optional, measured 2026-08-11 on Q5's 130 cohort refiles.**
   52 of the 130 (40%) landed `contested`, and the distribution rules out thin shelves as the
   cause:

   | target shelf | moved | contested | min relevance | avg relevance |
   | --- | --- | --- | --- | --- |
   | multivariable-calculus | 50 | 24 | 0.00 | 0.51 |
   | precalculus | 14 | 10 | 0.20 | 0.39 |
   | graph-theory | 11 | 5 | 0.10 | 0.37 |
   | cryptography | 11 | 5 | 0.00 | 0.40 |
   | number-theory | 11 | 3 | 0.10 | 0.46 |
   | machine-learning | 3 | 3 | 0.00 | 0.17 |
   | differential-equations | 30 | 2 | 0.30 | 0.81 |

   `differential-equations` came off a 9-member shelf through the quorum path and is the
   **cleanest** row in the table; `multivariable-calculus` has 67 primaries and is the worst.
   So this is not P4. The reading that fits: a Lamar Calculus III page sits in a neighbourhood
   dominated by `calculus` (389 primaries vs. 67), the evidence votes for the parent, the
   refile names the subtopic, and the guardrail records the disagreement — *"subtopics compete
   with their parents"*, which is P7's own sentence. Same shape for the PCA rows moved
   `linear-algebra` → `machine-learning`, 3 of 3 contested at avg 0.17. (Inference from shelf
   sizes and the P7 analysis; the losing topic is not stored on the row, so it is not directly
   measured.)

   Nothing is orphaned today — a contested primary stays retrievable by design — so this is
   latent, not broken. But it means **40% of a deliberate, human-authored curation decision is
   recorded in the database as doubt**, and it will stay that way until the vocabulary can say
   "subtopic of". Q7 re-scores these 130 rows; that is a measurement, not a fix.
2. **Duration honesty vs. availability** — making `durationMin` nullable is the correct model.
   `attach-candidates.ts` is already null-safe (its `durationFactor` returns 1 on null and the
   `MAX_ATTACHABLE_DURATION_MIN` gate at :131 passes null), so the real decision point is
   `track/allocate.ts`, which sums `durationMin` as a non-null number for slice budgets. Treat
   `unknown` as "exclude" or "assume a type-median" there? I lean type-median with the
   `durationSource` recorded, so a null never silently drops a good resource.
3. **Scope of B1** — repair only the 306 exact parent-array matches, or the full 554-row
   shared-array set? The extra 248 include legitimate sharing and need spot-checking.
4. **Beta timing** — this is a lot of churn against a live free beta
   (`free-beta.md`). Land Part 1 first and let Part 2 run gradually?
5. ~~**If Q6a finds no server-side slug→id route** — is a one-time browser-harvested id map an
   acceptable standing dependency?~~ **DISSOLVED 2026-08-11.** No id map is needed: the
   official YouTube Data API reaches the 755 video rows without touching Khan at all. The
   harvest was also the avenue Q6a ruled out on bot-detection grounds, so the question had no
   acceptable "yes" branch. The 175 articles and interactives it also covered do stay
   `unknown` until a reviewer touches them — that half is now settled policy, not an open
   question, and Q9 is the surface for it.
6. ~~**Is pinning KA's `hash` in our source acceptable operationally?**~~ **DISSOLVED
   2026-08-11.** There is no `hash`. The Data API is versioned and sanctioned, so there is
   nothing to re-capture and no rotation to catch.
7. ~~**Should `/review-pending-resources` block approval on `durationSource: 'unknown'`?**~~
   **RESOLVED 2026-08-10: no — surface it and let the reviewer fix it.** The queue is the final
   gate and the reviewer has the page open, so it is where an unknown gets resolved, not where
   it gets stuck. Same for topic. Scheduled as **Q9**.
