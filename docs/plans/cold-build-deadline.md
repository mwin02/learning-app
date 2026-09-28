# Cold-topic builds within the job deadline on Gemini 3

**Status:** active · **Blocks:** K1–K2; no PRs yet (K3 held) · **Block IDs:** `K` · **Started:** 2026-09-28

## Diagnosis

**A course on a topic the library has never seen does not finish inside the worker's 30-minute
job deadline on Gemini 3, so in production every cold-topic build currently fails.** The first
production build after the Gemini 3 deploy (`gemini-3-migration.md`) — program "learn system
design", course `database-systems`, request `cmulhi7fs000401s6e37ox70i`, 2026-09-28 — was
killed by `COURSE_JOB_DEADLINE_MS` at 16:51:16 → 17:21:16 while authoring concept banks. The
program's second course, `distributed-systems`, took 12 minutes just to reach `map-ready`.

The worker machine is not the cause. Over the VM's first 61 minutes, which spanned the whole
failed build, the system used ~175 s of CPU (~5% of one core; the e2-micro sustains 25%),
the container's cgroup reports `nr_throttled 0`, and the container held 250 of its 768 MiB
with no swap. The worker spent the build waiting on Gemini.

The time went to three things, reconstructed from the worker's per-call usage lines:

| Stage | Wall time | What ran |
| --- | --- | --- |
| Spine, review, on-ramp, candidate judges | ~2.5 min | healthy; the spine author took ~30 s |
| Map remediation (3 discovery rounds) | ~5.5 min | reached `map-ready` at 16:59 |
| Course remediation (9 discovery rounds, **serial**) | **~16 min** | each Pro grounded discovery call took 45 s – 2.6 min and emitted 3,209–6,024 output tokens, **80–95% of them thinking** |
| Concept-bank backfill (14 Pro calls, 4 at a time) | ~5.7 min, cut off | 2,261–5,460 output tokens per call, mostly thinking |

Two agents account for roughly 22 of the 30 minutes: `curriculumFallback` (grounded
discovery) and `conceptBankAuthor`. Both run on `gemini-3.1-pro-preview` at its default
thinking level, which the Gemini 3 migration deliberately left untuned for the Pro tier.

Two structural facts make a cold build pay all of it in one job:

1. **Remediation fills holes one at a time.** A cold topic has an empty library, so nearly every
   spine concept is a hole, and each costs one serial discovery round.
2. **The "best-effort" bank backfill sits on the critical path.** The worker awaits it
   before `buildTrack`, inside the deadline race. When the deadline fires there, the whole
   build is lost, including 29 minutes of remediation work that had already succeeded.

This predates Gemini 3 in kind, if not in degree: on 2.5, production already failed one
build at this deadline (request `…lfes0z`, 2026-08-30; its retry, with the map already
built, finished in 8 minutes).

## Locked decisions (this plan)

| Decision | Why |
| --- | --- |
| `curriculumFallback` gets `thinkingLevel: 'low'` | Measured on `gemini-3.1-pro-preview` with a grounded discovery-shaped call: 13.0 s / 774 thinking tokens at `low` vs 24.8 s / 2,275 at default. `'medium'` (21.9 s / 1,951) barely differs from the default. The call picks URLs out of search results; it applies judgement, but not deep reasoning |
| `conceptBankAuthor` keeps its default thinking level | Its registry comment records that the job is calibration: Flash over-reached, Pro wrote a tighter set. That quality is what the Pro choice bought, and nothing measured here says `low` preserves it |
| Instead, the bank backfill gets a time budget inside the job | It is best-effort by design and the Track already builds without banks (`build-track.ts:373-383`, exercises non-fatal). Bounding it keeps a slow bank pass from destroying a finished remediation. Concepts it doesn't reach are banked by a later build of the same Path |
| Remediation stays serial in this plan | Parallel holes would compete for the Path's `RemediationJob` single-flight, the split-then-re-pass loop and attach contention. Too much surface for this window; see Explicitly deferred |
| `COURSE_JOB_DEADLINE_MS` is not raised | It is chained to `REMEDIATION_JOB_STALE_MS` (35 m) and `COURSE_REQUEST_STALE_MS` (45 m) by ordering invariants (`config.ts:510-531, 559-596`). Raising it means moving all three, and it treats the symptom |
| No new dependency | Same SDK surface as the Gemini 3 migration's G1/G2 |

### Rejected alternatives

- **Move `curriculumFallback` to Flash.** Cheaper and faster, but discovery is what grows the
  library for every later learner, and the registry comment chose Pro deliberately. `low` on Pro
  recovers most of the time without changing the model.
- **`thinkingLevel: 'low'` on `conceptBankAuthor` too.** It would roughly halve the bank pass,
  but it trades away the calibration its comment describes. That's worth measuring, not assuming;
  revisit with a quality comparison.
- **Raise the deadline to 45 minutes.** See the locked row; it also makes a genuinely hung call
  stall the single-concurrency queue for longer.
- **Move the bank backfill entirely after `buildTrack`.** The first Track would then never have
  exercises for a cold topic, since exercises are sampled at build. A budget keeps most banks
  on a normal build and only drops them when time is short.
- **Roll the worker back to 2.5 until this ships.** Offered on 2026-09-28; the user chose to
  go straight to the fix. Production cold-topic builds fail until it lands.

## Codebase facts (verified 2026-09-28)

Registry and call sites:

- `curriculumFallback` is `{ modelId: PRO_MODEL_ID, maxOutputTokens: 32768 }` with no
  `thinkingLevel` (`src/lib/ai/models.ts:78-84`); its only caller is the discovery half of
  web fallback (`src/lib/agents/tools/web-fallback.ts:834`), which already passes
  `providerOptions` (G2).
- `conceptBankAuthor` is `{ modelId: PRO_MODEL_ID, maxOutputTokens: 32768 }`, and its comment
  calls it "off-the-hot-path (best-effort, once per concept)" (`src/lib/ai/models.ts`,
  the `conceptBankAuthor` entry); caller `src/lib/agents/content/author-concept-bank.ts:84`.
- `thinkingLevel` is honoured on `gemini-3.1-pro-preview` for `low`, `medium` and `high` (no
  error; token counts move). Live probe 2026-09-28, one run each, grounded
  discovery-shaped prompt: default 24.8 s / 2,603 out / 2,275 thinking; `low` 13.0 s / 1,075 /
  774; `medium` 21.9 s / 2,307 / 1,951; `high` 30.1 s / 3,042 / 2,732.

Worker pipeline:

- `processCourseRequest` races the pipeline against `COURSE_JOB_DEADLINE_MS` and aborts through
  one `AbortSignal` (`src/lib/services/course-worker.ts:95-170`).
- The pipeline order is ensure map → `remediatePath` → bank backfill → frontier concepts →
  `buildTrack` (`course-worker.ts:209-300`). The backfill is **awaited** under the same
  signal, inside a try/catch that turns its own failure into `bank-backfill-failed`
  (`course-worker.ts:271-287`). A deadline expiry during the backfill still fails the request,
  because the race, not the catch, decides the outcome.
- `backfillConceptBanks` processes bankless, non-cooling concepts in chunks of
  `CONCEPT_BANK_GEN_CONCURRENCY = 4` with `Promise.allSettled` per chunk
  (`src/lib/agents/content/generate-concept-bank.ts:179-205`; `config.ts:635`).
- Exercises are sampled into a Track at build, and a failure there is non-fatal: the Track
  ships `ready` without exercises (`src/lib/agents/track/build-track.ts:373-383`).
- `remediatePath` iterates holes serially within each of up to `MAX_REMEDIATION_PASSES = 3`
  passes, with a per-hole abort checkpoint (`src/lib/agents/track/remediate-path.ts:147-190`;
  `config.ts:173`).
- Deadline invariants: `COURSE_JOB_DEADLINE_MS` 30 m < `REMEDIATION_JOB_STALE_MS` 35 m <
  `COURSE_REQUEST_STALE_MS` 45 m (`config.ts:518, 571, 596`, with the ordering rationale in the
  comments at 510-531 and 559-596).

Production evidence (Cloud Logging, `learning-app-prod-mzw`, 2026-09-28):

- Build `cmulhi7fs…`: `processing` 16:51:16, `map-ready` 16:59:07, `remediation` succeeded
  17:15:32, `deadline-exceeded` 17:21:16 with two `concept-bank.generation-rejected` (the
  aborted in-flight calls). Worker VM CPU and memory figures above were read on the VM by SSH.
- Build `…lfes0z` hit `deadline-exceeded` on 2.5 on 2026-08-30.

`NEEDS VERIFICATION` (raised to the user; the plan relies on none of it being true):

- **Grounding under `low`.** The probe's own prompt returned 0–1 sources at every level,
  default included, so it says nothing about whether `low` changes how many attested
  citations the *real* discovery prompt yields. The first block's live check must measure
  this with the real call. A drop in attested URLs would block `low`.
- ~~What an aborted bank call leaves behind~~ — **resolved 2026-09-28**: a call aborted by
  its signal does *not* stamp `Concept.bankAttemptedAt` (`generate-concept-bank.ts:98-100`,
  "A deadline/shutdown abort says nothing about the concept"). So concepts that K2's budget cuts off
  stay eligible for the next build of the Path, as long as the cut-off goes through the
  `abortSignal` the call was given.
- **How long a cold build takes after K1.** Estimated from the probe (discovery about 2×
  faster): remediation ~16 min → ~8–9 min, total ~20 min before any bank work. That estimate
  rests on one probe run.

## Sequencing

Three blocks, stacked, smallest behaviour change first:

- **K1: `thinkingLevel: 'low'` on `curriculumFallback`**, plus its unit assertion and a live
  check of attested citations using the real discovery call. Registry-only.
- **K2: time-box the bank backfill inside the job.** Give it a budget derived from the job
  deadline, stop dispatching new chunks when the budget runs out, and make sure concepts
  that were cut off are not cooled. After a budget stop the pipeline continues to
  `buildTrack`.
- **K3 (held by the user, 2026-09-28): live proof and the runbook.** One cold-topic build against the dev DB, with the
  worker image, recording the stage timings beside the table above. Then note the ordering in
  `worker-deploy.md` if anything changed. Its acceptance criterion is that the build completes
  under the deadline with margin.

Deployment is the same as the Gemini 3 migration: the app auto-deploys; the worker needs
`worker-deploy.md` §9. Both K1 and K2 change worker behaviour.

## Explicitly deferred

- **Parallel remediation holes.** The largest remaining win (9 serial rounds), and the riskiest
  change: single-flight, split passes and attach contention all assume one hole at a time.
- **`thinkingLevel` on `conceptBankAuthor`**, pending a quality comparison.
- **`thinkingLevel` on the other Pro authors** (spine author, spine reviewer, on-ramp, track
  composer). They were not on this build's critical path.
- **Raising or re-deriving the deadline chain.**
- **Replacing the multi-line `console.log` usage prints** (`[map-spine-author] { usage … }` and
  similar). They break the one-JSON-object-per-line logging convention and turn each call into
  about 30 Cloud Logging entries. Real, but unrelated to the deadline.
- **Rolling the worker back** to 2.5 in the meantime (the user's call; see Rejected alternatives).

## Open questions for you

Answered 2026-09-28:

1. **K2's budget: remaining time.** The bank pass may use whatever is left of the job
   deadline after reserving a fixed tail for frontier concepts and `buildTrack`.
2. **K3 is held.** No cold-topic live build in this plan for now; the production build after
   deploy is the evidence.
3. **K1 and K2 ship together and deploy** (app and worker) once both pass their gates.

## K1 measured results (2026-09-29)

The real discovery half (`discoverForConcept` → `runDiscovery` → `resolveAttestedUrls` →
`describeCandidates`), topic `system design`, concept `Consistent hashing` (0 matching
Resources and 0 matching Concepts in the dev DB), oversample 6, empty deny list. Both runs in
one process, back to back. The default run is the identical call with `thinkingConfig` removed
from the Pro `generateContent` request body at the fetch layer; nothing in `src/` was changed
for the probe, and it wrote no DB rows. Latency is the Pro grounded request alone.

| Level | Latency | Output tokens | Thinking tokens | Sources | Attested | Described rows |
| --- | --- | --- | --- | --- | --- | --- |
| `low` | 17.5 s | 1,523 | 680 | 8 | 8 | 5 |
| default | 48.3 s | 4,903 | 4,263 | 8 | 8 | 5 |

An earlier session's default run of the same call (its `low` row was lost to output
truncation) measured 41.1 s / 3,637 out / 3,047 thinking / 4 sources / 4 attested, so the
default's variance is wide. Grounding is not reduced at `low`: both levels attested the same
number of citations, overlapping on three of the five described URLs.

## K1 — Run grounded discovery at a low thinking level (~25 LOC)

**Base branch:** `main`
**Files owned:**
- `src/lib/ai/models.ts` (modify)
- `src/lib/ai/models.test.ts` (modify)

**What it does.** `curriculumFallback`, the Pro grounded-discovery agent, gains
`thinkingLevel: 'low'`, so every web-fallback discovery call reaches
`gemini-3.1-pro-preview` with `thinkingConfig.thinkingLevel: 'low'` via the G2 plumbing
already in `web-fallback.ts`. Its registry comment states the measured reason (the
probe numbers in Codebase facts) and what was checked about grounding. No other agent's
config changes.

**Out of scope.** `conceptBankAuthor` and every other Pro author keep their default (deferred
by decision). No prompt, `maxOutputTokens` or model-id change. The bank budget is K2.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/models.test.ts` (unit, pure) — extend the tier suite.

**Acceptance criteria.**
- [ ] `getModel('curriculumFallback').providerOptions` deep-equals
      `{ google: { thinkingConfig: { thinkingLevel: 'low' } } }`, and its `modelId` is still
      the Pro id.
- [ ] The set of agents with a `thinkingLevel` is exactly the seven gate agents plus
      `curriculumFallback`; `conceptBankAuthor` and the other six Pro agents have
      `providerOptions` `undefined`.
- [ ] A live run of the **real** discovery call (the web-fallback discovery half, against a
      concept the dev library lacks) at `low` returns at least one citation that survives
      `resolveAttestedUrls`, and its thinking-token count is lower than a default-level run of
      the same call made in the same session. Both runs' latency, output tokens, thinking tokens
      and attested-URL counts are recorded in this plan doc. If `low` yields zero attested URLs
      where the default yields some, the block stops and reports instead of shipping.
- [ ] The `curriculumFallback` registry comment no longer describes the agent as running at the
      model default, and cites the measured numbers.

## K2 — Time-box the concept-bank backfill inside the job (~140 LOC)

**Base branch:** `K1`'s branch
**Files owned:**
- `src/lib/config.ts` (modify)
- `src/lib/services/course-worker.ts` (modify)
- `src/lib/agents/content/generate-concept-bank.ts` (modify)
- `src/lib/agents/content/generate-concept-bank.test.ts` (modify)
- `src/lib/services/bank-budget.ts` (new — pure budget arithmetic; name may differ if a
  better-fitting existing module is found)
- `src/lib/services/bank-budget.test.ts` (new)

**What it does.** The worker gives the bank backfill a budget equal to what is left of
`COURSE_JOB_DEADLINE_MS` after reserving a new fixed tail
(`BANK_BACKFILL_TAIL_RESERVE_MS`, 5 minutes) for frontier concepts and `buildTrack`, measured
from when the job started. `backfillConceptBanks` stops dispatching new chunks once the
budget is spent. At the budget boundary it aborts its in-flight calls through a signal
derived from the job signal, so a cut-off call is treated as an abort: not stamped, still
eligible next time. It then returns normally with a count of concepts it didn't reach, and
the pipeline continues to frontier concepts and `buildTrack`. A budget of zero or less skips
the backfill entirely. The job deadline, and every existing deadline invariant, are
unchanged.

**Out of scope.** Remediation concurrency, the deadline chain, and `conceptBankAuthor`'s
thinking level (all deferred). No change to how `buildTrack` samples exercises. The shutdown
(SIGTERM) path must behave exactly as today: a job-signal abort still aborts the backfill and
is still not confused with a budget stop.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/services/bank-budget.test.ts` (unit, pure) for the budget arithmetic;
`src/lib/agents/content/generate-concept-bank.test.ts` (unit, stubbed generator) for the
stop and abort behavior. Follow the file's existing stubbing pattern.

**Acceptance criteria.**
- [ ] Budget arithmetic: with a 30 min deadline, a 5 min reserve and a job started 10 min ago,
      the budget is 15 min. Started 26 min ago, it is ≤ 0, and the backfill is not called at all.
- [ ] With a budget that expires after the first chunk, `backfillConceptBanks` dispatches
      exactly one chunk, returns without throwing, and reports the remaining concepts as
      not reached. No later chunk's generator is invoked.
- [ ] A generator call still in flight when the budget expires sees its `abortSignal` aborted,
      and the concept is **not** stamped with `bankAttemptedAt`. The existing "abort does not
      stamp" behavior is the mechanism, with no new stamping path.
- [ ] An abort of the **job** signal (deadline or shutdown) during the backfill behaves as
      before this block: the backfill rejects or throws as it does today, and the budget path
      does not swallow it into a normal return.
- [ ] After a budget stop, the worker logs one `course-worker.concept-banks` line carrying the
      not-reached count, and proceeds to `buildTrack`. No `bank-backfill-failed` line is
      emitted for a budget stop.
- [ ] `BANK_BACKFILL_TAIL_RESERVE_MS` lives in `config.ts` with a comment stating the
      invariant: it must be less than `COURSE_JOB_DEADLINE_MS`. `process.env` is not read.
