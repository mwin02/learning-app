# Faster course builds

**Status:** active · **Blocks:** V1–V3 (stack 1); V4–V7 sketched, briefs pending stack 1's production data; no PRs yet · **Block IDs:** `V` · **Started:** 2026-10-03

## Diagnosis

**Most of a slow build's Track-build time is not spent on work. Two silent Flash calls that
stalled for minutes account for 5.75 of the 13.5 minutes in the slowest production Track
build. Everything else is serial: concepts are sourced one at a time, and courses are built
one at a time.**

### The idle gaps are two stalled Flash calls

`cold-build-deadline.md`'s production results reported two unexplained idle gaps in the
`database-systems` Track build (request `cmulhi7fs000401s6e37ox70i`, 2026-09-30). The worker
logs for 15:56–16:16 UTC show what was running during each one:

| Gap | Last line before | Next line after | What was in flight |
| --- | --- | --- | --- |
| 16:04:02 → 16:07:47 (3.75 min) | `[web-fallback] summary` for `getting-started-databases` (persist finished) | `[map-candidate-judge]` for the same concept, `gemini-3.7-flash`, **969 total tokens, 94 thinking** | The judge call. Between `summary` and the judge there are only two Prisma reads (`source-concept.ts:216-225`), and no warning was logged |
| 16:08:25 → 16:10:22 (2 min) | `[web-fallback] describe call` for `sql-aggregations` (grounded prong done) | `[youtube-search] sourced` | The YouTube prong, which runs alongside the grounded prong (`web-fallback.ts:701`). Its only slow step is `deriveChildConcepts` → `callDeriver` (`conceptDeriver`, Flash). That call **logs nothing, records no usage and gets no abort signal** (`concepts.ts:241-252`; `youtube-search.ts:115-119`). The googleapis fetches before it have a 10 s timeout (`GOOGLEAPIS_FETCH_TIMEOUT_MS`) |

The same calls normally finish in seconds. The same build's other judge calls landed 3–5 s
after their `summary` line (16:02:20→16:02:25, 16:13:08→16:13:11). A YouTube prong with
its deriver took ~30 s (16:11:26→16:11:57). Nothing bounds a single model call: no call
site sets a timeout, and the AI SDK's own retries back off for seconds, not minutes. So
**one slow Vertex response stalls the whole serial pipeline behind it.** These logs can't
tell one slow request apart from a run of retries, because no line records a duration. The
fix is the same either way.

The rest of that Track build: first compose ~1 min (16:00:53→16:01:52), thicken 11.3 min
(16:01:53→16:13:12, six concepts sourced one after another), second compose 51 s, then
sectioning and exercises in 17 s. The composer is not the bottleneck.

### Everything else is serial at three levels

1. **Courses.** The worker runs one job at a time (`scripts/course-worker.ts:71-77` awaits
   `processCourseRequest`). The two courses of the "learn system design" program ran back to
   back, 16:14:20 being both the first course's `fulfilled` and the second's `processing`.
   That made **28 min of wall time for a program whose slower course took 14.6.**
2. **Concepts within a build.** The thicken cycle sources up to `TRACK_MAX_THICKEN_CONCEPTS = 6`
   concepts in a plain `for … await` (`thicken-seam.ts:92-107`). Remediation does the same per
   hole within each pass (`remediate-path.ts:154-191`).
3. **Banks against the Track build.** The bank backfill is awaited before frontier concepts and
   `buildTrack` (`course-worker.ts:280-295`), but only `exerciseTrack`, the last step of
   `buildTrack`, reads banks (`build-track.ts:378-384`). Banks took 1 and 3 min in the two
   2026-09-30 builds, all of it on the critical path.

### What makes the serial shape safe to change

- The worker machine is idle: ~5% of one core during a cold build (`cold-build-deadline.md`), and
  302 MiB container peak across two builds (`worker-deploy.md` §7).
- N > 1 workers already work end to end (#234–#238). Claims use `FOR UPDATE SKIP LOCKED`.
  Same-Path builds serialize on the `ensurePathMap` advisory lock and the `RemediationJob`
  single-flight. Every job keeps its own trace, deadline and abort (see Codebase facts).
- The per-concept sourcing primitive (`sourceAndAttachConcept`) touches only its own concept's
  rows, apart from the Path row that `recomputeReadiness` writes. Its web-sourced candidate ids
  are rows that call created, so two concepts sourcing at once never attach the same new row.

### And one latent bug the parallel work would make worse

`buildTrack` calls `thickenSpine` **without the job's abort signal** (`build-track.ts:199-204`;
`ThickenRequest` has no such field, `thicken-seam.ts:25-36`). A deadline or SIGTERM during
a thicken cycle therefore doesn't stop the sourcing. The race fails or requeues the request,
but up to six sourcing rounds keep running as a zombie and keep writing `ConceptResource`
rows. Remediation was threaded in audit 2.2; thicken never was.

## Locked decisions (this plan)

| Decision | Why |
| --- | --- |
| Stack 1 (V1–V3) ships and deploys on its own; stack 2's briefs are written from its production data | The user's call, 2026-10-03. V3's thresholds and stack 2's concurrency levels should come from measured latencies, not one build's logs |
| Instrument before tuning: every model call logs one `ai.call` JSON line with its duration, and the worker records wall time per stage | Without it the two biggest losses read as "idle". The fix for parallel work is also impossible to judge without per-step times |
| Per-call timing lives in one middleware applied in `getModel`, not at ~20 call sites | `getModel` is the single seam every agent resolves through (`models.ts:350-352`), and `ai@6.0.191` ships `wrapLanguageModel`. The silent `conceptDeriver` gets timed without anyone remembering to add a log there |
| The Flash-tier agents get a per-call timeout of **90 s with one retry** on timeout | Their normal latency is seconds (above), so 90 s cuts only the stalls. The retry is a fresh request, and a model call has no side effects. Pro authors get no timeout in this plan: their normal latency (17–48 s discovery, ~1 min compose) is too close to any safe bound to choose without V1's data |
| A call timeout (after its one retry) or an abort ends the deriver's batch: no bisect retry, no split | `deriveWithBisect` retries twice and then bisects on any throw (`concepts.ts:186-231`). For a timeout that would multiply a stall by the bisect budget, and a timeout says nothing about which item is bad |
| A timeout retry never fires on a job abort | A deadline or shutdown must still stop the call. Only the timeout's own signal triggers a retry |
| `conceptDeriver` gets the job's abort signal | It is the one sourcing-ladder call that ignores it, so a stalled deriver also outlives its job |
| Bounded concurrency through one small, pure pool helper, not chunks | Chunked `Promise.allSettled` (the bank/judge idiom) waits on the slowest of each chunk. Given the stalls above, a pool that refills as each item finishes is the right shape. No new dependency |
| Per-concept sourcing concurrency **3** (`CONCEPT_SOURCING_CONCURRENCY`), shared by thicken and remediation | Six thicken targets become two waves. With two builds in flight that is ≤ 6 sourcing rounds at once, plus up to 4 bank calls per build. Higher values multiply Vertex burst for little gain |
| A concept that throws (anything but an abort) is logged and counted as attaching nothing; its siblings carry on | Under concurrency, a Postgres deadlock (40P01) or a pool-wait timeout on one concept's attach transaction becomes possible. Today one throw fails the whole remediation through `runRemediation`'s catch (`remediate-path.ts:243-248`). An abort still propagates exactly as today |
| Remediation runs conflation holes first and serially, then the gap holes concurrently | `splitConcept` deletes a concept and rewires its edges in one transaction (`split-concept.ts:107-152`). Conflations are rare, so keeping them serial costs little and removes a structural writer from the concurrent set. A declined split falls back to gap sourcing, which joins the concurrent set |
| Thicken receives and honours the job's abort signal | Fixes the latent bug above. A concurrent thicken would otherwise make up to 3× more zombie writes |
| The bank backfill overlaps frontier concepts and the Track build. `buildTrack` waits for it just before `exerciseTrack` | Total time becomes max(banks, track) instead of banks + track, which is never worse than today. It also retires the problem that K2's fixed 5-min tail reserve is smaller than a thickening Track build: the backfill no longer runs before the Track build, so it needs only a short tail for `exerciseTrack` and the finish |
| `BANK_BACKFILL_TAIL_RESERVE_MS` drops to **2 min**, and its comment states the new meaning: the time kept free after banks settle for `exerciseTrack` (no LLM) and `finishCourseRequest` | The backfill now runs alongside the Track build, so the reserve no longer has to cover it. The invariant `< COURSE_JOB_DEADLINE_MS` stays and is pinned in `config.test.ts` |
| The overlapped backfill promise is wrapped so it can never reject | `scripts/course-worker.ts:115-118` exits the process on any unhandled rejection. With two jobs per process, a stray rejection would kill both builds and strand both claims for the 45-min stale window |
| Two builds per process (`COURSE_WORKER_CONCURRENCY = 2`, a constant in `config.ts`) | The user's choice (two containers would use ~900 of 963 MiB; e2-small leaves the free tier). One process shares the Node runtime, the Prisma client and the 10-connection pool |
| Roll back concurrency by redeploying the previous image (`worker-deploy.md` §9), not with an env knob | An env knob would also need `worker-vm-startup.sh` to forward it (it forwards no tuning keys today). An image rollback is already the documented path |
| Maintenance (stale reclaim, both sweeps, the queue-depth gauge) runs once per poll cycle, whatever N is | These are table-wide and idempotent, so running them N times would only multiply DB load and log noise |
| Each slot claims as `<hostname>:<pid>:<slot>` | `claimedBy` is observability only (D6). Distinct ids keep two concurrent jobs apart in the failed-builds view and the logs |
| `--once` stays single-job | It is the external-scheduler mode, and one claim per invocation is its contract |
| The deadline chain is not touched | `COURSE_JOB_DEADLINE_MS` 30 m < `REMEDIATION_JOB_STALE_MS` / `PATH_BUILD_STALE_MS` 35 m < `COURSE_REQUEST_STALE_MS` 45 m is pinned in `config.test.ts:30-40`. Nothing here lengthens a job |
| A peak-memory measurement with two builds running at once gates the concurrency block, measured locally before any production deploy | See Open questions for the pass bar |
| No new dependency | Pool helper, middleware and timeouts are all `ai` SDK + Node built-ins |

### Rejected alternatives

- **Two worker containers on the e2-micro**, or an **e2-small**: rejected by the user (memory;
  cost and leaving the free tier). See `worker-deploy.md` §7.
- **Raise `BANK_BACKFILL_TAIL_RESERVE_MS` to cover a thickening Track build (~14 min).** That
  would starve the bank pass on every slow remediation, and the right number is unknowable:
  Track-build time depends on how many concepts thicken. Overlapping makes the reserve
  independent of Track-build length.
- **Derive the reserve from a predicted Track-build time.** Same problem: it predicts the
  thicken count before the composer has run.
- **`thinkingLevel: 'low'` on `trackComposer` now.** Measured at 51 s – 1 min per call in
  the slow build, so ≤ 2 min even when it runs twice. It writes learner-facing framing,
  and a quality check costs more than it saves. Deferred.
- **`low` on `discoveryDescriber`.** One describe call took ~7 s (16:03:46→16:03:54).
  Nothing to win.
- **Retry discovery at the default thinking level when `low` attests nothing.** It is a
  coverage lever, not a speed lever: each retry adds a 17–48 s Pro call to a round that, in
  the observed build, still filed resources through YouTube and the judge. Deferred and
  measured separately.
- **Run all holes of a remediation pass concurrently, splits included.** See the locked
  conflations-first row.
- **Parallelize across remediation passes.** Pass N+1's holes are what pass N's splits
  produced. The passes are serial by construction.
- **Make the thicken cycle async** (enqueue and rebuild later, per `thicken-seam.ts`'s
  2.5g note). That is a different product shape: the learner would get a first Track, then
  a second. Out of scope.
- **Chunked concurrency** (the bank/judge idiom). See the pool row.
- **Timeouts at each call site.** About 20 call sites, and the one that mattered here is
  the one nobody would have remembered.

## Codebase facts (verified 2026-10-03)

Worker loop and job isolation:

- `workerId = ${CLOUD_RUN_INSTANCE_ID ?? hostname}:${pid}`, one per process
  (`scripts/course-worker.ts:31`).
- `runWatch`: per poll cycle, `reclaimStaleClaims` → `sweepStuckPrograms` →
  `sweepPendingCarryOvers` → queue-depth gauge, then `while (cr = claimNextQueued(workerId))
  await processCourseRequest(cr, { shutdownSignal })`, then `sleep(COURSE_WORKER_POLL_MS)`
  (`scripts/course-worker.ts:41-81`; poll 5 s, `config.ts:504`).
- One shutdown `AbortController` handles SIGINT and SIGTERM. `main` awaits the loop and then
  calls `prisma.$disconnect()` (`scripts/course-worker.ts:94-105`). The process exits on
  `unhandledRejection` and `uncaughtException` (`:115-122`).
- `tickOnce` (the `--once` mode) runs maintenance and then at most one claim
  (`course-worker.ts:400-412`).
- `processCourseRequest` wraps each job in `runWithTrace(cr.id, …)`. That is an
  `AsyncLocalStorage` (`log.ts:27,57-61`), so `recordUsage` and `traceUsageSnapshot` stay
  per job under concurrency. Each call creates its own per-job `AbortController`, deadline
  timer, grace timer, and its own `abort` listener on the shared shutdown signal
  (`course-worker.ts:94-175`). So a shutdown releases every in-flight claim independently,
  each through `requeueShutdown`, whose `status='running'` guard makes duplicate writes
  no-ops (`:389-393`).
- `processRequestPipeline` receives `jobStartedAtMs` and runs: `ensureMap` → (`building`:
  `remediate`) → spine_ready gate → bank backfill (budget from `bankBackfillBudgetMs`,
  awaited, `logWarn('course-worker.bank-backfill-failed')` on throw) → frontier loop (serial,
  ≤ `MAX_FRONTIER_PER_TOPIC = 2`) → `build({ …, abortSignal })` → `finishCourseRequest`
  (`course-worker.ts:219-347`). `buildTrack` is passed **no `onTrace`**, so its stage events are
  dropped in the worker (`:328-336`; default `() => {}`, `build-track.ts:102`).
- `claimNextQueued(workerId)` is a single `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED
  LIMIT 1)` that stamps `claimedBy` (`course-request.ts:31-48`). `reclaimStale` requeues
  `running` rows older than `COURSE_REQUEST_STALE_MS` (45 m) (`:168-191`). A job can't
  outlive its 30 m deadline, so a sibling slot's reclaim can never take a live claim.
- Local compose runs `worker` with `deploy.replicas: 2` (`docker-compose.yml:51-54`).

Track build and thicken:

- The compose → validate → thicken loop: `needsThicken` fires on `!enough || thinForBudget.length > 0`,
  bounded by `TRACK_MAX_THICKEN_ATTEMPTS = 1`. So the composer runs at most twice
  (`build-track.ts:143-207`; `config.ts:457`).
- `thickenSpine` takes `{ pathId, underResourced, thinForBudget, targetMastery }`, with **no
  abort signal** (`thicken-seam.ts:25-36, 70`). It picks ≤ `TRACK_MAX_THICKEN_CONCEPTS = 6`
  targets (`config.ts:466`) and calls `sourceAndAttachConcept` serially without `abortSignal`
  (`thicken-seam.ts:92-107`).
- Order after the freeze transaction: `sectionTrack` (non-fatal) → `exerciseTrack`
  (non-fatal, no LLM) (`build-track.ts:365-384`).

Per-concept sourcing (`source-concept.ts`):

- `sourceAndAttachConcept` checks `abortSignal` up front, then runs the library rung →
  `judgeAndAttachCandidates` → the web budget → `sourceFromWeb` → `judgeAndAttachCandidates`
  (`:85-161`).
- The attach transaction: promote `pending_review → active` (`updateMany` by id) →
  `conceptResource.createMany(skipDuplicates)` → rejection-memory delete/insert →
  `markBankStale` → cap prune → `recomputeReadiness(pathId, tx)`. It passes `timeout:
  DB_WRITE_TX_TIMEOUT_MS` (30 s) **and no `maxWait`** (`:264-341`).
- `recomputeReadiness` reads the spine and writes `Path.status` with
  `path.update` (`recompute-readiness.ts:36-64`). Concurrent attach transactions on one Path
  therefore serialize on the Path row lock. Under READ COMMITTED a transaction can compute
  status from a snapshot without a sibling's uncommitted attach. That is harmless:
  attaching can only add primaries, and remediation recomputes from disk at every pass start
  and in its final transaction (`remediate-path.ts:149, 200-217`).
- Web-sourced `insertedIds` are rows created by that call. A URL that already exists comes
  back `skipped` or `membership_added` with empty `atomicIds` (`upsert-resource.ts:166-204`).
  `Resource.url` is `@unique` (`schema.prisma`, `model Resource`). Two concurrent rounds
  inserting one URL race check-then-create: the loser's transaction fails, and the catch
  returns `skipped` with `resourceId: null` (`upsert-resource.ts:376-382`). One concept
  drops a candidate; nothing throws. The same race already exists across two compose
  replicas.
- Library-rung candidates can overlap between concepts. Two attach transactions can then
  `updateMany` the same `Resource` rows. That can deadlock only if the two lock in
  different orders, and it surfaces as a throw.

Remediation:

- Single-flight is claimed **once per `remediatePath` call**, before the pass loop
  (`remediate-path.ts:138-142`). Concurrent holes inside one call share that claim and do
  not contend for it.
- Each pass loads its hole set once (`:149-151`). A split's finer nodes become the **next**
  pass's holes. Per-hole: `classifyHole` → conflation: `splitConcept` (`continue` on
  success, fall through to gap sourcing on decline) → `sourceAndAttachConcept({ requirePrimary:
  true, abortSignal })`; `progress` = any split or attach (`:153-196`).
- A throw anywhere in the loop lands in `runRemediation`'s catch → `finishJob('failed')`
  → outcome `failed` (`:243-248`).
- `splitConcept` deletes the coarse concept and recomputes inside one transaction
  (`split-concept.ts:107-152`).
- Integration coverage: `tests/integration/remediate-abort.test.ts`,
  `remediation-job.test.ts`.

Banks:

- `bankBackfillBudgetMs(jobStartedAtMs, nowMs, deadlineMs, reserveMs) = deadline − reserve −
  elapsed` (`generate-concept-bank.ts:42-49`). `backfillConceptBanks` runs chunks of
  `CONCEPT_BANK_GEN_CONCURRENCY = 4` (`config.ts:642`), its budget aborts in-flight calls
  through a derived signal, and a job abort still throws (`generate-concept-bank.ts:196-260`).
- `BANK_BACKFILL_TAIL_RESERVE_MS = 5 min` (`config.ts:578`).

Model calls:

- `getModel(name)` → `resolveModel(REGISTRY[name], env override)` → `{ model:
  chatModel(modelId), … providerOptions }` (`models.ts:325-352`). `chatModel` returns a
  provider model by id prefix (`vertex.ts:89-93`). `ai` is `6.0.191`, and `wrapLanguageModel({
  model: LanguageModelV3, middleware })` is exported. `ResolvedModel.model` is typed
  `LanguageModel` (a union that includes `string`), so wrapping needs the `LanguageModelV3` type
  threaded through without an `as` cast.
- `mapCandidateJudge` and `conceptDeriver` are Flash agents. `judgeCandidates` passes
  `abortSignal` (`candidate-judge.ts:76-85`). `callDeriver` passes none, and has no
  `recordUsage` and no log line (`concepts.ts:236-256`). `deriveChildConcepts` is called from
  `searchYouTubeForConcept` without a signal (`youtube-search.ts:115-119`), although that
  function receives one (`web-fallback.ts:702`).
- The SDK retries a call itself only for an `APICallError` marked retryable, at most
  `maxRetries = 2` times. It never retries an abort, and it waits for a server `retry-after`
  when that is under 60 s (`node_modules/ai/dist/index.mjs:2623-2700`). So a run of 429s can
  add up to ~2 min of waiting between attempts. Any other error, including a custom
  timeout error thrown from middleware, is not retried by the SDK, so a timeout retry has
  to live in the middleware.
- No call site in `src/` uses `streamText` or `streamObject`.
- `deriveWithBisect` retries each batch twice and then bisects under a shared call budget
  (`concepts.ts:174-231`). A per-call timeout therefore multiplies with its attempts: worst
  case is 2 attempts × (1 + 1 retry) × 90 s per node. That is still bounded by the bisect
  budget.
- Per-call usage is printed with multi-line `console.log` at ~17 call sites (for example
  `candidate-judge.ts:87-94`, `web-fallback.ts:860, 949`, `composer.ts:243`). `recordUsage`
  tracks tokens per stage, with no time (`log.ts:39-50, 73-83`). `CourseRequest.buildUsage`
  is `Json?` (`schema.prisma:1104`), and nothing in `src/` reads it outside the worker and
  the queue module, so optional new fields are backward compatible.

DB and quotas:

- One `PrismaClient` per process over `PrismaPg`, with no pool size configured
  (`db.ts:8-27`), so node-postgres defaults to 10. Concurrency inside one process does not
  add connections. Two jobs share the same 10 (`worker-deploy.md` §8).
- YouTube costs 100 units per `search.list` (`youtube-search.ts:6-7`) against 10k/day. One
  sourcing round costs the same whether it runs serially or in parallel: concurrency moves
  rounds earlier but doesn't add any.

Production evidence (Cloud Logging, `learning-app-prod-mzw`, `resource.type="gce_instance"`,
read 2026-10-03): the gap table above. Also: banks done 16:00:53, first `[track-composer]`
16:01:52, `[track-thicken] sourcing` 16:01:53, last thicken attach 16:13:12, second composer
16:14:03, `course-worker.fulfilled` 16:14:20 (29 calls), and the next course's
`processing` 16:14:20.

`NEEDS VERIFICATION` (raised to the user; noted where a block relies on it):

- **Vertex burst headroom.** Whether `gemini-3.1-pro-preview` and `gemini-3.7-flash` on the
  global endpoint run under dynamic shared quota or a per-project per-minute limit. That
  decides whether ~10–14 concurrent calls (two builds × (3 sourcing + 4 bank)) draw 429s.
  V1's `ai.call` line records failed attempts, so the V7 memory run doubles as the burst
  check.
- **One slow request or several retries** in the 3.75-min judge stall. V1 settles it. V3
  works either way.
- **Prisma's interactive-transaction `maxWait` default (2 s)** under the pg driver adapter. If
  the 10-connection pool is momentarily saturated, an attach transaction would fail with
  P2028 rather than wait. V4 sets an explicit `maxWait`; V2's stage timing will show
  whether pool waits happen at all.
- **The container cap is not a real cap on the VM.** `--memory=768m` plus the ~297 MiB the
  rest of the VM holds exceeds 963 MiB physical. A runaway would meet the kernel OOM killer
  before the cgroup limit. Not changed here (see deferred); it is why V7's pass bar is set
  against physical headroom, not against the cap.

## Sequencing

Seven blocks in two deployable stacks. Measurement first, risky concurrency last, so the
memory gate measures the final shape. **Stack 1 ships and deploys on its own (decided
2026-10-03).** Stack 2's briefs are written after stack 1 has run real production builds,
from their `ai.call` and `stage.timing` lines. So V4–V7 below are sketches, not briefs, and
`/orchestrate-feature` must not start them.

- **Stack 1: briefs below** (app + worker, `worker-deploy.md` §9):
  - **V1: log every model call's duration through one middleware** (~200 LOC).
  - **V2: record wall time per build stage** (~220 LOC). Stacks on V1.
  - **V3: time out stalled Flash calls and retry once; give the deriver the abort signal**
    (~200 LOC). Stacks on V2.

  Together these explain and remove the largest measured loss. Their production data is what
  stack 2's thresholds get tuned from.

- **Stack 2: sketched; briefs pending stack 1's data:**
  - **V4: pool helper, parallel thicken, abort for thicken** (~200 LOC). A new pure pool
    helper and `CONCEPT_SOURCING_CONCURRENCY = 3`. `thickenSpine` takes the abort signal,
    runs its targets through the pool and isolates per-concept errors. `buildTrack` passes the
    signal. The attach transaction gets an explicit `maxWait`.
  - **V5: parallel remediation gap holes** (~170 LOC). Within a pass, conflations run serially
    first, then gaps through the pool with per-hole error isolation. Stacks on V4 (the pool
    helper).
  - **V6: overlap the bank backfill with frontier and the Track build** (~220 LOC). Start the
    backfill without awaiting it, through a never-rejecting wrapper; `buildTrack` awaits it
    through an optional hook just before `exerciseTrack`; `BANK_BACKFILL_TAIL_RESERVE_MS` → 2 min
    with its new meaning. Independent of V4 and V5 in code, but stacked after them because
    all three raise concurrent Vertex load and V7 measures the sum.
  - **V7: two builds per worker process** (~220 LOC). `COURSE_WORKER_CONCURRENCY = 2`, a
    testable slot scheduler in `src/lib/services`, maintenance once per cycle, per-slot
    `workerId`, and shutdown that awaits every slot. Includes the two-builds peak-memory
    measurement and the `worker-deploy.md` §7/§8 updates. The measurement gates the
    production deploy of stack 2.

What stack 1's data has to answer before stack 2's briefs are written: the latency
distribution per agent (to confirm or move V3's 90 s, and to judge Pro timeouts); how often
V3's timeout fires and whether the retry succeeds; the split of a sourcing round between
discovery, validation, decompose, filing and upsert; whether any 429s appear; and what a
thicken concept costs end to end.

Deadline chain untouched throughout. Each stack changes worker behaviour, so each needs
`worker-deploy.md` §9 and, as proof, §11 step 1 (a real build the worker fulfils). Stack 1
also changes the app (any agent called from a route goes through the new middleware), and the
app auto-deploys on merge.

## Explicitly deferred

- **Timeouts on the Pro authors** (`curriculumFallback`, composer, spine author, bank author).
  Revisit with V1's latency distribution.
- **`thinkingLevel` on `trackComposer`** and on **`conceptBankAuthor`**. Both need a quality
  comparison. The composer measured ~1 min per call.
- **Discovery retry when `low` attests nothing.** Count it from V1-era logs first. It is a
  coverage lever, not a speed lever.
- **Parallel frontier concepts** (≤ 2, `course-worker.ts:311`). Each frontier add edits map
  structure, and with V6 they already overlap the banks.
- **Parallelizing `persistDiscovered`'s serial upsert loop** (`web-fallback.ts:571-641`, 37 s
  for three rows at 16:12:30→16:13:07). Plausible next target, but wait for V2's timing to
  split decompose, filing, embed and embeddability-classify.
- **Replacing the ~17 multi-line `console.log` usage prints.** V1's `ai.call` line carries the
  same data as one JSON object per call, which makes them redundant. Removing them is a
  mechanical sweep across ~17 files, so it gets its own cleanup change.
- **A user-facing retry for courses that failed before getting a Track**, and **the admin
  failed-builds page's RSC 503**. Unrelated to build speed.
- **Bringing the container's `--memory` cap under physical headroom** (see NEEDS
  VERIFICATION). It is an ops change to `worker-vm-startup.sh`. Revisit with V7's
  measurement.
- **More than two builds per process.** Measure two first.

## Open questions for you

Answered 2026-10-03:

- **Ship stack 1 alone first?** Yes. V1–V3 deploy (app and worker) and run production
  builds before stack 2's briefs are written.

Still open (none blocks stack 1):

1. **V7's memory pass bar.** Proposed: with two builds running at once in one local worker
   container (at least one doing web sourcing), cgroup `memory.peak` ≤ **450 MiB**, which
   leaves ~200 MiB of the VM's physical RAM free given the ~297 MiB the rest of the VM holds.
   If it fails: ship stack 2 with `COURSE_WORKER_CONCURRENCY = 1` (V4–V6 still help) and
   report, or stop? `OPEN` until V7's brief is written.
2. **Concurrency levels for stack 2.** `CONCEPT_SOURCING_CONCURRENCY = 3`,
   `COURSE_WORKER_CONCURRENCY = 2`. Revisit with stack 1's data.
3. **V3's timeout: 90 s with one retry** on the six Flash agents listed in V3. Locked as the
   default for stack 1 unless you object; stack 1's data then confirms or moves it.
4. **The `NEEDS VERIFICATION` items** above. Nothing blocks on them, but say if you
   already know the Vertex quota regime.

## V1 — Log every model call's duration through one middleware (~200 LOC)

**Base branch:** `main`
**Files owned:**
- `src/lib/ai/call-middleware.ts` (new)
- `src/lib/ai/call-middleware.test.ts` (new)
- `src/lib/ai/models.ts` (modify)
- `src/lib/ai/models.test.ts` (modify)
- `src/lib/ai/vertex.ts` (modify, only if `chatModel`'s return type must narrow to `LanguageModelV3` for wrapping)
- `src/lib/log.ts` (modify)
- `src/lib/log.test.ts` (modify)

**What it does.** Every model `getModel` resolves is wrapped, through the AI SDK's
`wrapLanguageModel`, in a middleware that times each `doGenerate` attempt. It emits one
`ai.call` JSON line per attempt through `@/lib/log`: agent name, model id, `durationMs`,
`outcome` (`ok` / `error` / `aborted`), input, output and reasoning token counts when the
provider returns them, `finishReason`, and the error message on failure. `ok` goes through
`log`, and `error`/`aborted` through `logWarn`, never `logError`, because the caller
decides whether a failure is a fault. `log.ts` gains a `recordTiming(key, ms)` that
accumulates `{ count, totalMs, maxMs }` per key into the current trace (a no-op outside one).
The middleware records under `ai.<agent>`. `traceUsageSnapshot` gains an optional `timings`
field and returns a snapshot when either usage or timings were recorded. Results and errors
pass through unchanged: this block is observation only.

**Out of scope.** Timeouts and retries (V3). Stage timing at pipeline call sites (V2).
Removing the ~17 multi-line `console.log` usage prints (deferred). Streaming: no call site
streams today, so only `wrapGenerate` is needed. `addUsageToSnapshot` (the intake
accumulator) is unchanged.

**Migration:** none (`buildUsage` is `Json?`; the new field is optional)
**New deps:** none (`wrapLanguageModel` and `MockLanguageModelV3` ship in `ai@6.0.191`)

**Tests.** `src/lib/ai/call-middleware.test.ts` (unit, `MockLanguageModelV3` from `ai/test`,
as in `decompose-agent.test.ts`). `src/lib/ai/models.test.ts` (unit, `chatModel` stubbed to
return a mock model). `src/lib/log.test.ts` (unit).

**Acceptance criteria.**
- [ ] A `generateText` call through a model wrapped for agent `mapCandidateJudge` writes
      exactly one stdout JSON line with `event: "ai.call"`, `agent: "mapCandidateJudge"`, the
      model id, a numeric `durationMs ≥ 0`, `outcome: "ok"`, and token counts equal to the
      mock's usage. The returned text equals the mock's output.
- [ ] A mock whose `doGenerate` throws a non-retryable error makes `generateText` reject with
      that error's message. Exactly one `ai.call` line is written, with `outcome: "error"` at
      warning level, and no error-level line.
- [ ] A call whose caller `abortSignal` is aborted logs `outcome: "aborted"`, not `"error"`.
- [ ] Inside `runWithTrace`, two calls for the same agent leave
      `traceUsageSnapshot().timings["ai.mapCandidateJudge"]` with `count: 2` and
      `totalMs ≥ maxMs ≥ 0`. Outside a trace, `recordTiming` neither throws nor records.
- [ ] `traceUsageSnapshot()` is `null` when neither usage nor timings were recorded. A trace
      with usage only yields `stages` and `totals` identical to the pre-block shape.
- [ ] With `chatModel` stubbed, a call through `getModel('conceptDeriver').model` writes an
      `ai.call` line with `agent: "conceptDeriver"`. With `MODEL_CONCEPTDERIVER` set to
      another id, the line reports the overridden id.

## V2 — Record wall time per build stage (~220 LOC)

**Base branch:** V1's branch
**Files owned:**
- `src/lib/log.ts` (modify)
- `src/lib/log.test.ts` (modify)
- `src/lib/services/course-worker.ts` (modify)
- `src/lib/agents/track/build-track.ts` (modify)
- `src/lib/agents/track/thicken-seam.ts` (modify)
- `src/lib/agents/tools/web-fallback.ts` (modify)
- `tests/integration/worker-pipeline.test.ts` (modify)

**What it does.** `log.ts` gains `timeStage(stage, fn, fields?)`. It awaits `fn`, records the
elapsed time with V1's `recordTiming`, emits one `stage.timing` JSON line (`stage`,
`durationMs`, `outcome: "ok" | "threw"`, plus any extra fields), and returns `fn`'s value
or rethrows its error unchanged. It is applied at these seams:
- the worker's top-level stages: `worker.map`, `worker.remediation`, `worker.banks`,
  `worker.frontier`, `worker.track-build`;
- `buildTrack`: `track.compose` (once per attempt), `track.thicken`, `track.persist`,
  `track.section`, `track.exercises`;
- each thicken concept: `track.thicken.concept`, with the slug;
- the web half of a sourcing round: `sourcing.discover` (per iteration), `sourcing.validate`,
  `sourcing.decompose`, `sourcing.file` (topic classification, embeddings and neighbour
  lookups before the upsert loop), and `sourcing.upsert` (the loop).

Because these go through the trace, `CourseRequest.buildUsage.timings` carries per-stage
totals for every build. Control flow, ordering and every existing catch stay exactly as they
are.

**Out of scope.** Any concurrency or reordering (stack 2). Threading the abort signal into
thicken (V4). Timing inside `upsertResource` itself. Passing an `onTrace` into `buildTrack`
from the worker: `timeStage` replaces that idea from the sketch.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/log.test.ts` (unit) for `timeStage`.
`tests/integration/worker-pipeline.test.ts` (`describeDb`, the existing `captureEvents`
helper and stubbed stages) for the worker stages and the persisted `buildUsage`.

**Acceptance criteria.**
- [ ] `timeStage` resolves to `fn`'s value and emits one `stage.timing` line with
      `outcome: "ok"`. When `fn` throws, the same error object propagates and the line has
      `outcome: "threw"`.
- [ ] A fulfilled pipeline run on a `spine_ready` map with stubbed stages emits `stage.timing`
      lines for `worker.map`, `worker.banks` and `worker.track-build`, in that order. The
      persisted `CourseRequest.buildUsage.timings` has those three keys, each with `count: 1`.
- [ ] A `building` map additionally emits `worker.remediation`. A request with no frontier
      concepts emits no `worker.frontier` line. A spent bank budget emits no `worker.banks`
      line, and the existing `course-worker.concept-banks` skip line is unchanged.
- [ ] A pipeline whose build stage throws emits `worker.track-build` with `outcome: "threw"`,
      and the request ends `failed` with the same `error` string as before this block.
- [ ] Live check (expected `untested` by the verifier unless a real build is run): one real
      worker build that thickens shows a `track.thicken.concept` line per sourced concept. For
      each, its `sourcing.*` lines plus the judge's `ai.call` lines account for the concept's
      duration within 10%.

## V3 — Time out stalled Flash calls and retry once; give the deriver the abort signal (~200 LOC)

**Base branch:** V2's branch
**Files owned:**
- `src/lib/ai/models.ts` (modify)
- `src/lib/ai/models.test.ts` (modify)
- `src/lib/ai/call-middleware.ts` (modify)
- `src/lib/ai/call-middleware.test.ts` (modify)
- `src/lib/agents/decomposition/concepts.ts` (modify)
- `src/lib/agents/decomposition/concepts.test.ts` (modify)
- `src/lib/agents/tools/youtube-search.ts` (modify)

**What it does.** `ModelConfig` gains an optional `callTimeoutMs`. It is set to 90 s (one
named constant in `models.ts`, with a comment citing this plan's Diagnosis) on exactly
`mapCandidateJudge`, `conceptDeriver`, `discoveryDescriber`, `tagCanonicalizer`,
`topicClassifier` and `validityAgent`. For those agents V1's middleware runs each
`doGenerate` attempt under the caller's signal combined with a fresh timeout. When the
timeout fires and the caller's signal has not aborted, it logs `ai.call` with
`outcome: "timeout"` and retries once. A second timeout throws an exported timeout error
naming the agent and the limit. A caller abort is never retried. Agents without
`callTimeoutMs` behave exactly as after V1. Separately, `deriveChildConcepts` accepts an
`abortSignal` and passes it to its model call, and `searchYouTubeForConcept` forwards the
signal it already has. An abort, or the timeout error, ends the deriver's work for that
batch: it does not count as a retryable failure in `deriveWithBisect` and never triggers a
split. Bisection exists for schema poison in one item; a timeout or abort says nothing about
any item, and splitting on it would multiply the stall by the bisect budget.

**Out of scope.** Timeouts on Pro agents or on the request-path Flash agents (`topicGate`,
`goalGate`, `intake`, and others): deferred. The SDK's `maxRetries` and its retry-after
handling (`index.mjs:2623-2700`) are unchanged, and their waits sit outside a per-attempt
timeout. No other call site gains a signal.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/call-middleware.test.ts` (unit; the middleware takes an injectable
timeout so tests use a few ms, or fake timers). `src/lib/ai/models.test.ts` (unit, registry
assertion). `src/lib/agents/decomposition/concepts.test.ts` (unit, following its injected-`run`
pattern).

**Acceptance criteria.**
- [ ] Exactly the six named agents have `callTimeoutMs === 90_000`. Every other agent's is
      `undefined`.
- [ ] A mock whose first `doGenerate` hangs until aborted and whose second resolves: the call
      succeeds with the second result, `doGenerate` ran twice, and two `ai.call` lines were
      written (`timeout`, then `ok`).
- [ ] A mock that hangs on every attempt: the call rejects after exactly two attempts with the
      exported timeout error, whose message names the agent and the limit. No third
      `doGenerate` call is made.
- [ ] A caller signal aborted mid-attempt: the call rejects as an abort after one `doGenerate`,
      with no retry and an `ai.call` line with `outcome: "aborted"`.
- [ ] An agent without `callTimeoutMs`, given a mock slower than the test's timeout value, is
      not cut off.
- [ ] `deriveWithBisect`, with a `run` that throws the timeout error (or an abort): one call
      only, no second attempt, no split, no `concepts.derive_batch_failed` line, and an empty
      map. A schema-style error still gets the existing retry-then-bisect behavior.
- [ ] `searchYouTubeForConcept` passes its `abortSignal` through `deriveChildConcepts` to the
      model call: with a stubbed deriver model, the signal it receives is aborted when the
      caller's is.
