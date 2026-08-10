# C2 — warm-path campaign record

Per-topic outcomes for the free-beta warm campaign (`docs/plans/free-beta.md` § C2,
step 6). Written for the beta announcement's honesty: what the 12 warm Paths are
actually made of, and where they are thin.

**Run against production** (Supabase `aws-1-us-west-1.pooler.supabase.com:6543/postgres`)
starting 2026-08-01, per `docs/operator-tooling.md`.

## Prerequisites resolved during the campaign

**The deploy pipeline was broken, and with it every migration since 2026-07-31.**
All six `deploy-main` builds on 2026-08-01 02:53–02:57 UTC failed at the `migrate`
step with `P1001` against `db.nsxavppjxvhsyzxnehui.supabase.co:5432`. Cause: the
post-leak credential rotation wrote `supabase-session-url` **v2** with the
**direct** DB endpoint, which is IPv6-only and unreachable from IPv4-only Cloud
Build workers — the exact trap `cloudbuild.yaml` and `operator-tooling.md` both
warn about. Fixed by adding v3 derived from `supabase-database-url` with the port
changed 6543 → 5432 (session pooler). Build `fc4c2645` then succeeded and applied
`20260731162422_rung0_r2_concept_candidate_rejection`.

This was load-bearing for C2: the current checkout queries
`ConceptCandidateRejection` (rung0-starvation R2), so **every** warm build and
even the read-only coverage probe crashed with `P2021` until the migration landed.

## Step 1 — map-layer reset

`reset-maps --yes --target-host=aws-1-us-west-1.pooler.supabase.com`, 2026-08-01.
Wiped 3 Paths / 2 Tracks / 64 Concepts / 224 ConceptResources and the
program+progress layer. Library preserved exactly: **2,012 Resources, 33 Sources,
36 TopicAliases, 1 User**. Snapshot in `backups/maps-2026-08-01T03-32-*.json`.

## Step 2 — sources added (the plan's OPEN question, settled here)

`precalculus` needed nothing — Khan Academy, Paul's Online Math Notes, Professor
Leonard and OpenStax already cover it; its C1 weakness was filing + rung-0
starvation, both since fixed. The other three new topics were genuinely thin.
Seven rows added to `data/seed-sources.ts` (33 sources total). Every row carries a
trust prior; the **four non-YouTube rows** (`postgresql-docs`, `sqlbolt`,
`visualgo`, `hyperphysics`) *also* widen the **web-discovery allowlist**
(`loadAllowlistDomains` reads seeded Source URLs), which is the half that matters
now that rungs 1–2 are reachable post-R1. The three YouTube rows do **not**:
`loadAllowlistDomains` explicitly excludes `youtube.com` and its subdomains, so a
seeded channel contributes a trust prior only (applied to a video via its
`youtubeChannelId`). This distinction is what the source postmortem below turns on.

| Slug | Name | Kind | Trust | For |
| --- | --- | --- | --- | --- |
| `postgresql-docs` | PostgreSQL Documentation | official_docs | 0.95 | sql |
| `sqlbolt` | SQLBolt | educator | 0.70 | sql |
| `abdul-bari` | Abdul Bari | educator | 0.85 | dsa |
| `visualgo` | VisuAlgo (Steven Halim, NUS) | educator | 0.70 | dsa |
| `walter-lewin` | Lectures by Walter Lewin | educator | 0.85 | physics |
| `hyperphysics` | HyperPhysics (Rod Nave, GSU) | educator | 0.85 | physics |
| `organic-chemistry-tutor` | The Organic Chemistry Tutor | educator | 0.70 | physics, precalc |

## Library reach per warm topic (before the campaign)

Own `ResourceTopic` rows on active resources, and what the T4d relation edges add:

| Topic | Own rows | Reachable via edges | Note |
| --- | --- | --- | --- |
| calculus | 445 | — | |
| linear-algebra | 265 | — | |
| statistics | 254 | +459 (`probability-and-statistics`) | sibling shelf, T4 kept both |
| javascript-react | 96 | +0 (`javascript` is empty) | |
| sql | 95 | — | edgeless by T4d measurement |
| python | 68 | +67 (`python-data-ml`) | |
| python-data-ml | 67 | +88 (`python`, `machine-learning`) | |
| precalculus | 50 | +445 (`calculus`) | 76 of 77 C1 attachments came through this edge |
| data-structures-algorithms | 31 | +68 (`python`, `javascript`) | |
| machine-learning | 20 | — | edgeless |
| physics-mechanics | 9 | — | edgeless by deliberate T4d call |
| **javascript** | **0** | — | edgeless; entirely web-sourced |

933 of 1,927 rows were unreachable from the warm set before topic-filing T4; the
large non-warm pools that remain are `probability-and-statistics` (459, reachable
from `statistics`) and `discrete-mathematics` (209, still unreachable).

## Step 3 — coverage dry run (measure before you spend)

`scripts/rung0-coverage.ts` over the built spines, read-only. The C1 finding was
that **100% of spine holes were rung-0 saturated** — the library returned enough
raw hits to zero the web budget, so web discovery never ran. Post-R1/R2 the same
probe reports an **upper bound on suppression**, not the budget.

Measured 2026-08-01 across all Paths with open holes: **7 of 21 spine holes
rung-0 saturated** (down from 100%).

- `javascript` — 12 of 13 spine concepts are holes, every one `rung0Hits=0`,
  `webShortfall=3`. Nothing suppressed; full web budget. This is the campaign's
  main spend, and it is spend the topic genuinely needs.
- `machine-learning` — 1 hole (`unsupervised-learning-clustering`), saturated by
  three off-target rows (two Random Forest, one Deep Learning) at distances
  0.42–0.44, just inside the 0.48 cutoff. This is precisely the pre-R1 defect:
  the judge will reject all three, and post-R1 the `requirePrimary` floor still
  guarantees a web look. A live demonstration of why R1 mattered.
- `python-data-ml` — 1 hole (`statistical-visualization-seaborn`), saturated by
  pandas-plotting rows. Same shape.
- `precalculus` — **4 holes, all 4 saturated**: `conic-sections`,
  `applications-of-trigonometry`, `graphs-of-trig-functions`,
  `function-composition-and-operations`. This is the C1 borrowed-shelf pattern
  reproduced exactly — the `precalculus → calculus` edge fills the candidate
  slots with calculus material and the divergent concepts starve. It is also the
  D4 cold-build failure (`function-transformations-and-compositions`) recurring
  under a slightly different spine slug.
- `data-structures-algorithms` — 3 holes, 1 saturated (`linked-lists`);
  `stacks` and `queues` have zero library hits and full budget.

Why this is expected to clear where D4 did not: `remediate-path.ts:187` passes
`requirePrimary: true` for every spine hole, and `webBudgetAfterLibrary`
(`source-concept.ts:174`) floors the budget at 1 when no *qualifying primary*
attached. So a saturated hole still buys a web look. Verified in the source
before spending, because this is precisely the mechanism whose absence caused the
D4 precalculus failure.

## Per-topic outcomes

Attachment counts, median trust, and source mix at spine-build time (before
remediation and before the review passes).

| Topic | Status after spine build | Spine | Frontier | Attached | Median trust | Top sources |
| --- | --- | --- | --- | --- | --- | --- |
| python | spine_ready | 13 | 9 | 87 | 0.69 | youtube 44, python-docs 32, corey-schafer 6 |
| python-data-ml | building (1 hole) | 12 | 9 | 79 | 0.69 | youtube 40, pandas-docs 13, scikit-learn-docs 10 |
| javascript | building (12 holes) | 13 | 0 | 1 | 0.80 | generated 1 |
| javascript-react | spine_ready | 12 | 8 | 74 | 0.95 | react-dev 42, youtube 30 |
| calculus | spine_ready | 14 | 9 | 101 | 0.85 | pauls-online-math-notes 60, youtube 21, khan-academy 13 |
| linear-algebra | spine_ready | 15 | 9 | 111 | 0.95 | khan-academy 64, youtube 35, mit-ocw 6 |
| machine-learning | building (1 hole) | 12 | 0 | 39 | 0.64 | youtube 27, openstax 8, statquest 3 |
| statistics | spine_ready | 12 | 9 | 98 | — | built on retry; 0 holes |
| sql | spine_ready | 12 | 0 | 47 | 0.85 | khan-academy 23, youtube 20, freecodecamp 3 |
| data-structures-algorithms | building (3 holes) | 14 | 9 | 53 | 0.95 | mit-ocw 33, youtube 5, python-docs 4 |
| precalculus | building (4 holes) | 14 | 0 | 49 | — | borrowed calculus shelf |
| physics-mechanics | building | 16 | 8 | 39 | — | thin 9-row shelf |

**6 of 12 reached `spine_ready` from the library alone**, with **zero
`primaryRelaxed` concepts anywhere** — no Path is hiding a hollow primary at this
stage. The remaining 6 carry 21+ spine holes into remediation.

`statistics` is the campaign's clearest win and a direct vindication of
topic-filing T4: it reached `spine_ready` with **0 holes and 98 attachments**
purely because T4 kept `probability-and-statistics` as a sibling shelf reachable
through a relation edge. Had C2 run before T4, this topic would have web-sourced
a parallel duplicate of an existing 459-row pool.

`statistics` also **failed its first spine build** and succeeded unchanged on
retry — a transient authoring failure, not a data problem. Worth knowing that a
single `failed` Path in a campaign log is not necessarily a real defect; retry
before investigating. (`isReclaimable` returns true for `failed`, so a retry is
just a re-run of the same command.)

Four Paths finished with **0 frontier concepts** (`javascript`, `machine-learning`,
`sql`, `precalculus`) — frontier enrichment is best-effort and sits outside
`ensurePathMap`'s try/catch, so it degrades silently. `scripts/backfill-frontier.ts`
tops these up; it does not affect `spine_ready`, which counts spine membership only.

`youtube` (0.5, unseeded-channel bucket) carrying the plurality on `python`,
`python-data-ml` and `machine-learning` is the honest weak spot — those are the
three lowest median-trust Paths, and they are where the review passes should be
aimed first.

## Step 3b — remediation results

`warm-paths.ts` over the 6 Paths that carried holes out of the spine build,
concurrency 2, in-process against Supabase.

| Topic | Holes in | Outcome | Relaxed | Escalated |
| --- | --- | --- | --- | --- |
| python-data-ml | 1 (saturated) | spine_ready | 0 | 0 |
| machine-learning | 1 (saturated) | spine_ready | 0 | 0 |
| data-structures-algorithms | 3 (1 saturated) | spine_ready | 0 | 0 |
| precalculus | 4 (all saturated) | spine_ready | 0 | 0 |
| javascript | 12 (none saturated) | spine_ready | 0 | 0 |
| physics-mechanics | 11 | spine_ready (3rd attempt) | 0 | 0 |

### javascript — the cold-start case

`javascript` is the campaign's cleanest test of discovery with **no library to
lean on**: 0 own `ResourceTopic` rows at recon, no inbound relation edge, and a
single `generated` on-ramp as its only attachment after the spine build. All 12
spine holes were web-sourced from scratch, and it finished **`spine_ready`, 0
relaxed, 0 escalated, 33 attachments**, median trust 0.69 — `youtube` 17,
`mdn` 12, `javascript-info` 2, `freecodecamp` 1.

Worth carrying into the announcement: an empty shelf is no longer a blocker for
warming a topic, which is what makes the warm set extensible beyond the curated
12. Note the `javascript-react → javascript` relation edge (declared but inert
while the shelf was empty) is now live, so React's Path gains a real foundations
pool on its next rebuild.

### The rung-0 fix, verified in production

**`precalculus` is the result that matters.** It is simultaneously the C1
borrowed-shelf case (76 of 77 attachments arriving through the `calculus` edge)
and the D4 cold-build failure (one spine concept with no acceptable resource, so
the Path never reached `spine_ready`). It carried **4 holes, all 4 rung-0
saturated** into remediation and came out **`spine_ready` with 0 relaxed and 0
escalated**. Under the pre-R1 code every one of those holes had a web budget of
zero and could only have been closed by relaxing to a hollow primary.

The mechanism, traced end to end on the first fix (`python-data-ml`'s
`statistical-visualization-seaborn`): rung 0 returned 3 hits, the judge rejected
them as non-teaching for the concept, `requirePrimary` floored the web budget at
1, web discovery found 11 candidates, 2 survived judging, 1 attached as primary.
Pre-R1 that concept would have been permanently starved in every pass and every
rerun.

**Every remediated Path closed its holes with a real primary — `primaryRelaxed`
is 0 across all 12 Paths.** This is the check the plan flags as necessary beyond
`spine_ready`, and it passes cleanly.

### A real defect surfaced: the final readiness transaction can time out

`physics-mechanics` remediation **failed** with:

```
Transaction API error: A commit cannot be executed on an expired transaction.
The timeout for this transaction was 5000 ms, however 6040 ms passed …
```

The failing call is `remediate-path.ts:209` — the final status-landing
`$transaction` (`primaryRelaxed` updateMany + `recomputeReadiness`), which runs
on Prisma's **default 5s** interactive-transaction timeout. `physics-mechanics`
has the largest spine in the warm set (16 concepts), and over the remote pooler
the recompute exceeded it.

**Nothing was lost** — all the sourcing and judging in that pass had already been
persisted (42 attachments), so only the final commit failed and the Path stayed
`building` with a terminal `failed` job. A retry is cheap, and the
`RemediationJob_active_per_path` partial unique index covers only
`queued`/`running`, so a terminal job does not block re-claiming.

A retry **failed again, running alone**, so this is reproducible and not a
concurrency artifact — and the second failure landed at a *different* call site:
`source-concept.ts:340`, inside the `judgeAndAttachCandidates` transaction
(`source-concept.ts:264`) that runs for **every hole**, not just the final
commit.

**Measured cause — it is round-trip latency, not a slow query.** Timed against
the pooler from the operator laptop:

| Operation | Time |
| --- | --- |
| `concept.findMany` (16 spine concepts, 33 attachments) | 687–1186 ms |
| a single `path.update` | 342–856 ms |

The queries are trivial; a bare single-row update costing ~350–850 ms is pure
network latency. The `judgeAndAttachCandidates` transaction issues **~9
statements** plus `BEGIN`/`COMMIT` — roughly 11 round trips. At ~350–700 ms each
that is 4–8 s against a 5,000 ms limit, which is exactly the 6,040 ms and
7,719 ms observed. It is marginal, which is why 4 of 6 topics passed and
`physics-mechanics` (the largest spine, 16 concepts) failed twice.

**This is predominantly an operator-laptop artifact, and an earlier note in this
document overstated the production risk.** The laptop is in UTC+8 and Supabase is
in `aws-1-us-west-1` — several hundred ms per round trip. The worker VM
(`us-central1`) and Cloud Run (`us-west1`) are tens of ms from the same database,
so the identical transaction costs well under a second there. Production is not
on the edge of this limit; the E1 local-app/remote-DB operator pattern is.

It is still worth a cheap fix, because a default 5 s budget spread over ~11
round trips is fragile by construction, and `pending-review.ts:229/:261`
recomputes readiness for **every affected Path in one transaction** when a
review reject lands — strictly more work than the call that failed here, and
reachable from the same high-latency operator laptop during C2 step 4.

**Fixed** (branch `fix/prisma-tx-timeout-operator-latency`): a
`DB_WRITE_TX_TIMEOUT_MS = 30s` config constant applied to the two failing call
sites plus both `pending-review.ts` transactions, which step 4 will exercise from
the same laptop. Raising the budget rather than splitting the transactions is
deliberate — the atomicity is load-bearing (`recompute-readiness.ts`: the
`Path.status` write must commit with the rows it was computed from).

**Verified on the failing case**: `physics-mechanics`, which failed twice at
6,040 ms and 7,719 ms, completed on the next run with **zero** transaction errors
in the log (610 s, 0 holes, 0 relaxed). `javascript` completed in the same run.

### And an operator error: do not exceed two concurrent warm processes

`javascript` also failed, but from a **different** cause, and the cause was
avoidable. Its error was

```
Transaction API error: Unable to start a transaction in the given time.
  at judgeAndAttachCandidates (source-concept.ts:264)
```

— connection-pool starvation (Prisma's `maxWait` for acquiring a connection),
not the commit timeout above. It fired seconds after a **third** `warm-paths`
process was started to retry `physics-mechanics` while `javascript` was still
remediating. Each `tsx` process builds its own `adapter-pg` pool (10
connections), so three processes meant ~30 client connections into the Supabase
pooler that the Cloud Run service (max 4 × 10) and the worker VM also share.

`warm-paths.ts` defaults to `--concurrency 2` for exactly this reason. Running a
second *process* silently doubles it and the guard doesn't see it. **Retry a
failed topic after the current run finishes, not alongside it** — `cloudbuild.yaml`
already documents the same shared-pool budget for Cloud Run and
`worker-deploy.md` §7 for the worker side.

## Final state — all 12 warm Paths

**12 / 12 `spine_ready`. `primaryRelaxed` = 0 across every Path. 0 escalations.**
No Path closed a hole with a hollow primary, which is the check `free-beta.md`
step 5 flags as necessary beyond `spine_ready`.

| Topic | Spine | Attached | Median trust | Top sources |
| --- | --- | --- | --- | --- |
| python | 13 | 87 | 0.69 | youtube 44, python-docs 32, corey-schafer 6 |
| python-data-ml | 12 | 81 | 0.69 | youtube 42, pandas-docs 13, scikit-learn-docs 10 |
| javascript | 13 | 33 | 0.69 | youtube 17, mdn 12, javascript-info 2 |
| javascript-react | 12 | 74 | 0.95 | react-dev 42, youtube 30 |
| calculus | 14 | 101 | 0.85 | pauls-online-math-notes 60, youtube 21, khan-academy 13 |
| linear-algebra | 15 | 111 | 0.95 | khan-academy 64, youtube 35, mit-ocw 6 |
| machine-learning | 12 | 42 | 0.65 | youtube 28, openstax 8, statquest 4 |
| statistics | 12 | 98 | 0.95 | khan-academy 75, youtube 18, statquest 2 |
| sql | 12 | 47 | 0.85 | khan-academy 23, youtube 20, freecodecamp 3 |
| data-structures-algorithms | 14 | 60 | 0.95 | mit-ocw 33, youtube 14, python-docs 4 |
| precalculus | 14 | 57 | 0.85 | pauls-online-math-notes 28, khan-academy 17, youtube 6 |
| physics-mechanics | 16 | 64 | 0.66 | youtube 34, khan-academy 16, organic-chemistry-tutor 13 |

Library after the campaign: **1,954 active**, 159 `pending_review` (up from 122 —
remediation's discoveries feed the review queue), 17 `human_review`, 4 awaiting
decomposition.

### Where these Paths are thin — state this plainly in the announcement

**Trust is carried by the unseeded-YouTube bucket on three topics.**
`machine-learning` (median 0.65), `physics-mechanics` (0.66) and the three 0.69
Python/JS topics lean on `youtube` rows, whose Source prior is **0.5 — the
"known platform, unvetted channel" bucket**, deliberately just above open web.
`linear-algebra`, `statistics`, `javascript-react` and `data-structures-algorithms`
sit at 0.95 and are genuinely well-sourced. The difference is real and visible to
learners.

**159 pending-review rows are attached to these maps right now.** Discovery rows
are usable in the run that found them and hidden from *future* runs until
approved, so the warm Paths already serve resources no human has graded. Draining
that queue (step 4) is what converts this from provisional to verified, and
rejects will regress some Paths out of `spine_ready` — expected, and what step 5's
re-remediation exists for.

### Did the new sources earn their place? Mostly not, yet.

| Source | Rows in library | Attached to maps |
| --- | --- | --- |
| `organic-chemistry-tutor` | 15 | 17 |
| `abdul-bari` | 2 | 2 |
| `visualgo` | 1 | 1 |
| `postgresql-docs` | 0 | 0 |
| `sqlbolt` | 0 | 0 |
| `walter-lewin` | 0 | 0 |
| `hyperphysics` | 0 | 0 |

Only 3 of 7 contributed. The four that didn't split into **three** cases, because
the mechanism differs by row type — YouTube rows never touch the allowlist:

- **`postgresql-docs` / `sqlbolt` were never exercised.** `sql` reached
  `spine_ready` from the library alone, so it had no holes, so no web discovery
  ran for it. These rows are not disproven — they are untested non-YouTube hosts,
  and they widen the allowlist for future SQL sourcing.
- **`hyperphysics` was exercised and did not surface.** `physics-mechanics` ran 11
  holes through web discovery. `hyperphysics` is a non-YouTube host, so it *was* on
  the allowlist and admissible — and the search pulled 34 rows from unseeded
  YouTube channels instead. Being on the allowlist does not make the search prefer
  a Source: the allowlist only decides what is *admissible*, and ranking is
  coverage-then-trust over what the query actually returned.
- **`walter-lewin` never had an allowlist to be measured against.** It is a YouTube
  channel, and `loadAllowlistDomains` excludes `youtube.com`, so its non-appearance
  is **not** an allowlist signal — it only means physics discovery didn't pull one
  of its videos. The YouTube trust-prior path itself works: `organic-chemistry-tutor`,
  also a YouTube channel, surfaced 15 rows and applied its 0.70 prior via
  `youtubeChannelId`.

The transferable lesson from step 2 therefore rests on **`hyperphysics` alone**
(n=1) and is worth holding as a lead, not a proven law: for a canonical *site*,
seeding makes it admissible but not preferred — the allowlist is a gate, not a
preference — so seeding is necessary but not sufficient to get it represented.
Steering the YouTube prong toward a specific *channel* is a separate lever that
seeding does not touch.

## Operational notes

- **`warm-paths.ts` runs in-process on a laptop, not on the worker VM.** It
  deliberately bypasses the `CourseRequest` queue (a CourseRequest is
  Track-oriented and per-learner; warming targets the shared Path/map layer
  below it). The worker VM sat idle throughout. C2 is therefore *not* the
  cloud workers' shakedown — that already happened in D4.
- **A laptop shutdown mid-campaign did not corrupt anything, and did not even
  stop the run.** The original build process survived and was still running on
  resume, alongside a second one started to finish the remainder. Both raced
  the same topic list safely: `ensurePathMap` tx1 takes
  `pg_advisory_xact_lock(hashtext(topic))` and the loser hits `isBuildInFlight`
  and skips, so each topic is built exactly once. This is the Workers-A2
  concurrency guard earning its keep outside the worker fleet.
- **A spine build's frontier enrichment is degradable by design** (it sits
  outside `ensurePathMap`'s try/catch), so an interrupted build leaves a valid
  spine-only map; `scripts/backfill-frontier.ts` tops it up.
