# Pro-tier agents to Flash, where quality holds

**Status:** active · **Blocks:** M1–M8; no PRs yet · **Block IDs:** `M` · **Started:** 2026-10-07

## Diagnosis

**Three Pro-tier agents account for most of a warm build's model time. Whether they can move
to Flash is an empirical question that the repo cannot answer today. There is no way to run
one agent on two configurations over the same inputs and score the difference.**

Production request `cmuro8iil000301s6fy7bj5fq` (operating-systems, warm spine, one thicken
cycle of 4 concepts, fulfilled in 8.5 min; Cloud Logging, `resource.type="gce_instance"`,
trace filter):

| Agent (all `gemini-3.1-pro-preview`) | Calls | Total | Max | On the critical path? |
| --- | --- | --- | --- | --- |
| `curriculumFallback` (grounded discovery, `low`) | 4 | 156 s | 51 s | **Yes.** 28–62 s of each 39–86 s thicken concept |
| `conceptBankAuthor` | 19 | 491 s | 35 s | Yes today (2.9 min before the Track build); **not after build-speed V6** |
| `trackComposer` | 2 | ~92 s | 47 s | Yes, but ≤ 2 calls per build |

The Flash agents in the same build were all fast (judge ≤ 3.8 s, deriver ≤ 4.6 s, describer
≤ 9.8 s), and no 90 s timeout fired. One bank call drew a Vertex **429 "Resource exhausted"**
with ~4 bank calls in flight. That is the burst ceiling build-speed V7 (two builds per
process) would push into.

`gemini-3-migration.md` rejected this move for three reasons. These agents author
learner-facing artifacts that are cached forever, a regression would be invisible in logs,
and there was no time to A/B. The first two still hold. The third is what this plan
supplies. Two things make it possible now: build-speed V1–V3 (`ai.call` lines with
per-attempt `durationMs`, `stage.timing`, `buildUsage.timings`), and a fact found while
planning: **all three agents are pure LLM boundaries whose inputs can be rebuilt from DB
rows.** Discovery takes `(topic, conceptTitle, oversample, denyList, allowDomains,
targetMastery)`, and its deny list starts empty for each concept. The bank author takes
`(topic, conceptTitle, resource titles)`. The composer takes a loaded map plus a learner
scenario. None of them writes. So the comparison can replay real production inputs
read-only, with no risk to the library.

### What changed from the starting proposal

1. **"Answer-key agreement" can't be measured for banks.** Flash and Pro write *different
   questions*, so there are no shared keys to agree on. The bar is **answer-key
   correctness**, graded blind: a Pro grader call that sees no arm label, then a human read.
2. **Every bar is relative to Pro's own run-to-run variance** where variance matters. All
   three agents are nondeterministic at temperature 1.0, so the composer's baseline runs
   twice, and the Pro-vs-Pro distance is the yardstick.
3. **Banks are mostly a quota-and-cost question, not a latency one, once V6 lands.** V6
   overlaps the backfill with the Track build. The case for moving banks is the 429 and the
   price. Pro is $2/$12 per 1M tokens, Flash $0.75/$3.75 (until 2027-01-01, then
   $1.50/$7.50). That still argues for doing it before V4, because V7's concurrency has to
   be tuned against whichever quota banks draw on.
4. **The composer's output decides whether the build thickens.** `resourceSufficiency`
   drives `needsThicken` (`build-track.ts:201-202`). A Flash composer that says `enough` more
   often would look faster by skipping thicken cycles that Pro would have run. Thicken-
   decision agreement is a pass bar, and a skipped thicken is never a speed win.
5. **A Pro-at-`low` arm** for banks and the composer, as a fallback when both Flash arms
   fail. It meets the latency goal, though not the cost or quota goal.
6. **`mapSpineAuthor` is on the hot path, just not often.** Frontier adds
   (`add-frontier-concept.ts:161`, ≤ 2 per build) and remediation splits
   (`split-concept.ts:223`) both call it. It still stays on Pro: cached-forever structure,
   low call count.

## Locked decisions (this plan)

| Decision | Why |
| --- | --- |
| Three candidates, in order: `curriculumFallback`, `conceptBankAuthor`, `trackComposer` | Biggest critical-path win with the lowest risk first. Discovery URLs are attested, then filtered by validity and the judge, so its only failure mode is *yield*. Banks reach learners as answer keys. Composer output is learner-facing framing plus the thicken trigger |
| `mapSpineAuthor`, `mapSpineReviewer`, `onRampAuthor`, `onRampCritic` stay on Pro | Cached-forever structure and lessons, few calls per build |
| **Arm ladder, cheapest first, stop at the first pass:** Flash `low` → Flash default → Pro `low` (banks and composer only) | The decision rule is "the fastest arm that passes", and the ladder is in expected-latency order. Stopping early is also how the run stays under the budget. Pro `low` is only reached if both Flash arms fail, and ships if it passes (the user's answer, 2026-10-07) |
| **Total comparison spend ≤ $15**, enforced by the harness rather than estimated (the user's cap, 2026-10-07) | A ledger accumulates the real per-call cost across every run and driver. The allotments are discovery $4, banks $5, composer $4, reserve $2. A driver refuses to start, or stops before the next input, when its allotment would be exceeded |
| **Each driver pilots 2 inputs per arm first**, projects the full run from the measured cost, and shrinks the input set to fit its allotment | Per-call cost is unmeasured for the Flash arms. Each driver has a **minimum input count** below which its bars mean nothing. If the budget can't reach the minimum, the driver stops and reports, and does not run a weaker comparison |
| Grounding queries are costed at $14 / 1,000 in the ledger, ignoring the 5,000/month free tier | Conservative. The free tier is shared with production and its remaining balance isn't visible. The query count comes from `groundingMetadata.webSearchQueries` |
| Arms are applied through a scoped, in-process override (`AsyncLocalStorage`), never through `MODEL_<AGENT>` | The env var swaps only `modelId`, which is the registry's deliberate rule. The arms also vary `thinkingLevel`. A scope changes nothing for deployments and can't leak across concurrent calls |
| The same scope carries a **call sink** that `callTimingMiddleware` reports to | Gives the harness per-attempt latency, tokens and grounding query count for *every* model call inside a driver, including the describer, validity and judge calls discovery triggers, with no edits at agent call sites |
| Inputs are real production rows, read-only, through `run-against-prod.ts` | Prompts aren't logged, but every input can be rebuilt from rows. Dev's library and Source table differ from production's. All three boundaries are write-free |
| Composer scenarios are synthetic, written in the driver, not real `CourseRequest` goals | Keeps learner goal text out of local result files. `compare-composers.ts`'s calculus scenarios are the precedent |
| Input sets are fixed in the driver source before any run, and include the concepts touched by `cmuro8iil000301s6fy7bj5fq` | So the inputs can't be picked to fit a result |
| Results go to `docs/audits/pro-to-flash/` (git-ignored); the summary table is copied into this doc | Raw JSONL and the human-read samples hold model output, not code. `docs/audits/` is already the repo's local-only home for audit output |
| Pass bars are written here, before any result, and never moved after a run | A failed bar keeps the agent on Pro, and the result is recorded in this doc |
| Each move is its own block and PR, merged one at a time; **the worker deploys once, after every passing move has merged, followed by one combined soak** (the user's answer, Q4) | One deploy and one soak instead of three. Per-agent attribution survives because the soak metrics are per-agent log lines. A single agent rolls back by reverting its PR and redeploying (`worker-deploy.md` §9) |
| A moved agent gets `FLASH_CALL_TIMEOUT_MS` only if its arm's **max** attempt latency in the harness is ≤ 30 s | One third of the 90 s bound, so the timeout still only cuts stalls. Otherwise none, deferred to production `ai.call` data |
| A comparison-only `compareGrader` registry entry (Pro, default thinking) | Every model call resolves through the registry and gets the timing middleware. It is never called by production code |
| No new dependency | `ai` SDK, Prisma and Node built-ins |

### Rejected alternatives

- **Dev-DB fixtures as harness input.** Reproducible, but discovery's scoped rung reads the
  allowlist from the `Source` table, and the bank and composer inputs are library rows, so
  dev and production differ. Production rows, read-only, are just as reproducible once the
  input set is frozen in the driver.
- **Replaying captured production prompts.** No prompt is logged (`ai.call` carries metadata
  only), and adding prompt logging puts learner goal text into Cloud Logging.
- **Arms through `MODEL_<AGENT>` env vars.** Covers `modelId` only.
- **Running every arm, not a ladder.** About twice the spend, and it doesn't fit $15 once the
  composer's large prompts are counted. The extra arms only answer questions the decision
  rule doesn't ask.
- **Shadow mode in production** (Flash alongside Pro on live builds). It doubles cost on the
  hot path and needs the same scoring as the harness.
- **An LLM grader alone for banks.** A Pro grader isn't blind to model style and can share
  Pro's mistakes. It is the screen; the human read is the gate.
- **A soak per move.** Three deploys and three waits on production volume. Rejected by the user.
- **`gemini-3.8-flash` as the target.** Same price and terms as 3.7, unverified. Retargeting
  the whole Flash tier is its own follow-up (`gemini-3-migration.md`).
- **`markBankStale` as the bank rollback.** It only flags *reviewed* banks for manual
  re-curation and regenerates nothing (`mark-bank-stale.ts:1-20`). See M6's rollback note.

## Pass bars (written 2026-10-07, before any result)

"Baseline" means today's registry config. A candidate arm passes only if it clears **every**
bar for its agent. Each driver runs the baseline first, then walks the ladder and stops at
the first arm that passes.

### `curriculumFallback` — target 10 concepts, minimum 8; baseline × 2 runs, each arm × 1

Per concept, the driver replays **rung 1** (`discoverForConceptScoped`, oversample 6, empty
deny list, production's allowlist), then `runValidationPipeline` with production's
validators, then `judgeCandidates`, all in memory. Baseline metrics are the mean of its two
runs.

| Metric | Bar |
| --- | --- |
| Attested candidates per call (median across concepts) | ≥ 80% of baseline's |
| Validity survivors per call (median) | ≥ 80% of baseline's |
| Judge-scored `teaches` candidates, summed across concepts | ≥ 90% of baseline's sum |
| Concepts with zero `teaches` candidates | ≤ baseline's count + 1 |
| p50 discovery-call latency | ≤ 60% of baseline's p50 |

### `conceptBankAuthor` — target 15 concepts, minimum 12; baseline × 1, each arm × 1

| Metric | Bar |
| --- | --- |
| Answer-key errors, from `compareGrader` (sees each bank with no arm label) | ≤ baseline's rate, and ≤ 3% absolute |
| Out-of-scope questions (grader: needs a concept other than this one, or a specific the titles don't establish) | ≤ baseline's rate + 5 points |
| Kept / authored (MCQ format drop rate) | ≥ baseline's − 5 points |
| **User's blind read of 30 questions per arm** (baseline and the candidate), shuffled, labels in a separate key file | **0 wrong answer keys** in the candidate's sample; the user can veto on style |
| p50 call latency | ≤ 60% of baseline's p50 |

### `trackComposer` (`composer.ts`, `TRACK_COMPOSER_MODE = 'single'`) — target 2 Paths × 4 scenarios, minimum 2 × 3; baseline × 2 runs, each arm × 1

| Metric | Bar |
| --- | --- |
| Lesson concept-set Jaccard vs baseline run 1 (mean) | ≥ mean baseline-run-2-vs-run-1 Jaccard − 0.10 |
| Thicken decision (`enough`, and whether `thinForBudget` is non-empty) matches baseline run 1 | in ≥ 80% of compositions, and **never** "no thicken" where both baseline runs said thicken |
| `validateComposition` primary-fallback warnings | ≤ baseline run 1's count + 1 across the set |
| Intent matches baseline run 1 | in ≥ 75% of compositions |
| **User's side-by-side read of track title, summary and lesson framing** for 4 compositions | the user's call |
| p50 call latency | ≤ 60% of baseline's p50 |

### Combined production soak, after the single worker deploy

The next ≥ 3 production builds after the §9 deploy are read from Cloud Logging. For every
moved agent, the per-agent metrics the logs carry must sit within the harness's measured range
for the chosen arm:

- `ai.call` durations for that agent
- `[web-fallback] discovery call` attested counts
- `[content-author-concept-bank]` kept/dropped
- `[track-composer]` `enough`, and the thicken count

If an agent falls outside its range, revert that agent's move PR and redeploy. This is a
post-merge operation, not a block criterion.

## Codebase facts (verified 2026-10-07)

Registry and resolution:

- Seven agents use `PRO_MODEL_ID = 'gemini-3.1-pro-preview'`; `FLASH_MODEL_ID = 'gemini-3.7-flash'`
  (`src/lib/ai/models.ts:67-68`). Neither is exported.
- `FLASH_CALL_TIMEOUT_MS = 90_000` (`models.ts:74`), set on six Flash agents. No Pro agent has
  `callTimeoutMs`.
- `curriculumFallback`: Pro, `thinkingLevel: 'low'`, 32768 (`models.ts:89-108`).
  `conceptBankAuthor`: Pro at the default, 32768 (`models.ts:212-224`). Its comment says
  "Flash over-reached at 8 questions; Pro authors a tighter set of 5". That was measured on
  2.5 Flash; the target has since been set to 5 (`CONCEPT_BANK_TARGET_QUESTIONS`,
  `config.ts:636`). `trackComposer`: Pro at the default, 32768 (`models.ts:178-187`).
- `getModel(name)` → `resolveModel(REGISTRY[name], process.env['MODEL_' + NAME], name)`, read
  per call. Only `modelId` is overridable. `resolveModel` wraps the model with
  `withCallTiming(chatModel(modelId), agent, { timeoutMs })` and builds `providerOptions`
  from `thinkingLevel`.
- `AGENT_NAMES` is a `const` tuple; `AgentName` derives from it (`models.ts:11-34`).
- `callTimingMiddleware.wrapGenerate` sees each attempt's `result.usage` (input, output,
  reasoning) and `model.modelId`, and logs one `ai.call` line per attempt. It carries **no
  prompt** (`src/lib/ai/call-middleware.ts`, `timed`). `call-middleware.ts` imports from
  `@/lib/log`; `models.ts` imports from `call-middleware.ts`.
- `log.ts` already uses one `AsyncLocalStorage` for traces (`log.ts:27, 66-69`). It is the
  idiom a second scope should follow.
- The grounding query list is on the provider result:
  `providerMetadata.<provider>.groundingMetadata.webSearchQueries?: string[]`
  (`node_modules/@ai-sdk/google/dist/index.d.ts:114`, `index.mjs:1717-1720, 2253`). It is
  keyed by `providerOptionsName`, so readers check both `vertex` and `google`.

Call sites and inputs:

- `curriculumFallback`: only `web-fallback.ts:860` (`runDiscovery`). It feeds
  `resolveAttestedUrls`, then `describeCandidates` (`discoveryDescriber`, Flash).
- Discovery's ladder: rung 1 = `discoverAllowlisted` (YouTube prong +
  `discoverForConceptScoped` with `allowDomains`); rung 2 = `discoverForConcept`
  (`web-fallback.ts:227-237`). `allowDomains` comes from the private
  `loadAllowlistDomains()` (`web-fallback.ts:782-793`), which reads `Source` rows.
  `oversample` is `REMEDIATION_DISCOVERY_OVERSAMPLE = 6` (`config.ts:132`). The deny list
  starts empty per concept and grows only within the ladder (`web-fallback.ts:327, 345`).
- Production validators: `VALIDATORS = [livenessValidator, rulesAgentValidator]`
  (`web-fallback.ts:165`), run through `runValidationPipeline(rows, validators)`, which is in
  memory (`validation/index.ts:36`).
- `judgeCandidates({ conceptTitle, conceptSlug, candidates: SearchResult[], isOnRamp,
  abortSignal })` works on in-memory `SearchResult` objects (`candidate-judge.ts:54-66`;
  shape at `search-resources.ts:66`).
- `conceptBankAuthor`: only `author-concept-bank.ts:84`. `authorConceptBank({ topic,
  conceptTitle, conceptSlug, isOnRamp, resources: {title, type}[], targetCount })` returns
  questions and never persists (header, `:14-19`).
- `trackComposer`: `composer.ts:217` (live; `TRACK_COMPOSER_MODE = 'single'`, `config.ts:483`)
  and `composer-agent.ts:267` (not live). `composeTrack` (`composer.ts:160`) is a pure
  boundary over `loadComposerMap(pathId)` (`build-track.ts:552`). `validateComposition`
  returns `{ lessons, warnings }` (`validate-composition.ts:66-70, 79`).
  `scripts/compare-composers.ts` drives both read-only and defines four calculus scenarios.
- `resourceSufficiency` decides thickening (`build-track.ts:201-206`).
- `mapSpineAuthor` is also called by `add-frontier-concept.ts:161`, `split-concept.ts:223` and
  `frontier-author.ts:65`.

Banks and rollback:

- `ConceptQuestion` has `origin` and `createdAt`, and no model provenance
  (`schema.prisma:907-920`).
- The backfill selects `{ pathId, isOnRamp: false, questions: { none: {} } }`, minus concepts
  whose `bankAttemptedAt` is still cooling (`generate-concept-bank.ts:210-216`). **A concept
  whose questions are deleted gets a fresh bank on the next build of its Path.**
- `markBankStale` only flags `bankReviewed` concepts for manual re-curation. It never
  regenerates (`mark-bank-stale.ts:1-20, 54`).

Scripts and deploy:

- Drivers that spend LLM calls stay manual `scripts/*.ts` drivers, not Vitest
  (`.claude/rules/testing.md:22`). `tsconfig.json` includes `**/*.ts`, so scripts are
  typechecked by `npm run verify`.
- `run-against-prod.ts` points any driver at the Supabase pooler without the secret becoming
  a shell word.
- `/docs/audits/` is git-ignored (`.gitignore`).
- Every course-build stage runs on the worker. The app runs only request-time agents
  (`worker-deploy.md`, "A model retarget reaches the worker only through §9"). The only app
  route that reaches these three agents is the `DEV_AUTH`-gated
  `src/app/api/playground/build-track/route.ts`.

`NEEDS VERIFICATION` (none blocks a brief):

- **Whether Flash and Pro draw on separate quota pools** on the global endpoint. That
  decides whether moving banks actually prevents the 429. The bank driver runs at
  `CONCEPT_BANK_GEN_CONCURRENCY = 4` and records 429s per arm; the combined soak confirms it.
- **The Flash arms' per-call cost.** Unmeasured; that is what each driver's pilot is for.

## Sequencing

```
main ── M1 ── M2 ─┬─ M3 ──(run, passes)──▶ M4  (from main)
                  ├─ M5 ──(run, passes)──▶ M6  (from main)
                  └─ M7 ──(run, passes)──▶ M8  (from main)
                                   then one worker §9 deploy + combined soak
```

- **M1: scoped agent override and call sink** (~180 LOC).
- **M2: comparison harness core: arms, ledger, budget, stats** (~260 LOC). Stacks on M1.
- **M3: discovery comparison driver** (~240 LOC). Stacks on M2.
- **M5: bank comparison driver and blind grader** (~280 LOC). Stacks on M3, for a linear
  chain `/merge-stacked-prs` can order; no code dependency on M3.
- **M7: composer comparison driver** (~250 LOC). Stacks on M5, same reason.
- **M4, M6, M8: the moves** (~40–60 LOC each). Each branches from `main` after M1–M7 have
  merged **and** its driver's run has passed. The pass table goes into this doc in the same
  PR. A move whose driver failed is **not implemented**; its row records the result.
- Then **one** `worker-deploy.md` §9 deploy and the combined soak. build-speed V4's briefs
  wait for the soak.

The drivers are run by the user (or by an orchestrator conversation with the user's OK) in
order M3 → M5 → M7, so the ledger's reserve covers any re-pilot.

## Explicitly deferred

- **`mapSpineAuthor`, `mapSpineReviewer`, `onRampAuthor`, `onRampCritic`.** They stay on Pro.
  Revisit `mapSpineAuthor` if production `ai.call` data shows frontier/split calls on the
  critical path.
- **Timeouts** on agents that stay on Pro, and on a moved agent whose harness max is above
  30 s. Set from production `ai.call` distributions.
- **`gemini-3.8-flash` for the whole Flash tier.** A separate retarget.
- **Model provenance on `ConceptQuestion`.** The `createdAt` window is enough for one
  rollback.
- **The `composer-agent.ts` path.** Not live.
- **Rung 2 (open-web) discovery in the comparison.** Rung 1 is the common path and has the
  same model call. Rung 2 only runs when rung 1 came up short.
- **Re-authoring existing Pro banks on Flash.** Existing banks are untouched.

## Open questions for you

1. ~~Pro `low` as a fallback arm~~ — **answered 2026-10-07: yes.** If both Flash arms fail for
   banks or the composer, the driver runs Pro `low`, and it ships if it passes.
2. ~~Human-read sizes~~ — **answered 2026-10-07: yes**, 30 bank questions per arm and
   4 composer compositions.
3. ~~p50 ≤ 60% of baseline~~ — **answered 2026-10-07: yes.**
4. ~~Soak per move~~ — **answered 2026-10-07: one combined soak after all moves.**
5. ~~Spend cap~~ — **answered 2026-10-07: $15 max, as low as possible.** Enforced by M2's
   ledger.

---

## M1 — Add a scoped agent-config override and a per-call sink (~180 LOC)

**Base branch:** `main`
**Files owned:**
- `src/lib/ai/compare-scope.ts` (new)
- `src/lib/ai/compare-scope.test.ts` (new)
- `src/lib/ai/models.ts` (modify)
- `src/lib/ai/models.test.ts` (modify)
- `src/lib/ai/call-middleware.ts` (modify)
- `src/lib/ai/call-middleware.test.ts` (modify)

**What it does.** A new module holds one `AsyncLocalStorage` scope for comparison runs. It
carries a per-agent config override (any of `modelId`, `thinkingLevel`, `maxOutputTokens`,
`callTimeoutMs`) and an optional call sink. Inside the scope, `getModel(name)` resolves
`REGISTRY[name]` merged with that agent's override, which wins over `MODEL_<AGENT>` too.
Outside it, `getModel` behaves exactly as today. `callTimingMiddleware` reports every attempt
to the scope's sink, when one is present: agent, modelId, durationMs, outcome, input/output/
reasoning tokens, and the grounding query count read from
`providerMetadata.{vertex|google}.groundingMetadata.webSearchQueries` (0 when absent). The
`ai.call` log line is unchanged. The scope lives in its own module so `models.ts` and
`call-middleware.ts` both import it without a cycle.

**Out of scope.** Arms, prices, ledger and stats (M2). Any registry entry change (M4/M6/M8).
Exposing the override through env or any deployment path. It is reachable only by
calling the scope function.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/compare-scope.test.ts` (unit, pure: scope nesting, isolation between
two concurrent `Promise.all` branches). `src/lib/ai/models.test.ts` (unit: override applied
inside the scope, ignored outside, beats an env override). `src/lib/ai/call-middleware.test.ts`
(unit: sink receives one record per attempt including a timed-out attempt, query count from
provider metadata, no sink means no error).

**Acceptance criteria.**
- [ ] Inside the scope with `{ conceptBankAuthor: { modelId: 'gemini-3.7-flash', thinkingLevel: 'low' } }`, `getModel('conceptBankAuthor')` returns `modelId: 'gemini-3.7-flash'` and `providerOptions.google.thinkingConfig.thinkingLevel === 'low'`. Outside the scope it returns `gemini-3.1-pro-preview` with no `providerOptions`.
- [ ] With `MODEL_CONCEPTBANKAUTHOR` set and a scope override present, the scope's `modelId` wins. With the env set and no scope, the env still wins over the registry, as today.
- [ ] An override for one agent does not change `getModel` for any other agent in the same scope.
- [ ] Two concurrent scopes in one `Promise.all`, with different overrides for the same agent, each see only their own override.
- [ ] A middleware attempt inside a scope with a sink delivers exactly one sink record per attempt (two for a timed-out-then-retried call), with `webSearchQueries` counted from provider metadata under either the `vertex` or `google` key, and `0` when absent.
- [ ] Outside any scope, the middleware's behaviour and its `ai.call` line fields are unchanged, and the existing call-middleware tests pass unmodified.
- [ ] No `process.env` read is added outside `models.ts`'s existing `getModel`.

## M2 — Build the comparison harness core: arms, cost ledger, budget guard, stats (~260 LOC)

**Base branch:** M1's branch
**Files owned:**
- `src/lib/ai/model-compare.ts` (new)
- `src/lib/ai/model-compare.test.ts` (new)
- `scripts/model-compare-harness.ts` (new)

**What it does.** The pure half (`src/lib/ai/model-compare.ts`) defines:
- the arm set: `baseline`, `flash-low`, `flash-default`, `pro-low`, each an override map for
  one agent;
- a price table: Pro $2/$12, Flash intro $0.75/$3.75, Flash 2027 $1.50/$7.50 per 1M tokens,
  and grounding at $14 per 1,000 queries, with the 2026-09-28 source date in a comment;
- cost of a call record at each price point;
- p50/max latency;
- Jaccard over string sets;
- the budget projection: given an allotment, spend so far, and pilot cost per input per arm,
  how many inputs fit, and whether that meets a minimum.

The script half (`scripts/model-compare-harness.ts`) gives drivers one entry point. It runs a
function under an arm's scope with a sink and returns the sink records plus cost. It keeps a
persistent ledger at `docs/audits/pro-to-flash/ledger.json` (cumulative spend per driver and
total, against the $15 cap and the per-driver allotments: discovery $4, banks $5, composer
$4, reserve $2). It appends JSONL results under `docs/audits/pro-to-flash/`, and refuses to
run an input whose projected cost would cross the driver's allotment or the cap. The ladder
order is a constant: `flash-low`, `flash-default`, `pro-low`.

**Out of scope.** Any agent-specific scoring or input loading (M3, M5, M7). Registry
changes. Reading `.env*` files.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/model-compare.test.ts` (unit, pure: cost at each price point including
grounding, p50 of even/odd lengths, Jaccard edge cases, projection that fits / shrinks /
falls below the minimum).

**Acceptance criteria.**
- [ ] A call record of 1,000,000 input and 1,000,000 output tokens on `gemini-3.1-pro-preview` costs $14.00; on `gemini-3.7-flash`, $4.50 at the intro price and $9.00 at the 2027 price. 1,000 grounding queries add $14.00 at every price point.
- [ ] An unknown model id in a call record makes the cost function throw, instead of costing it at $0.
- [ ] The projection returns "fits N" when the allotment covers N inputs, a smaller N when it covers fewer than the target, and "below minimum" when it covers fewer than the minimum.
- [ ] With the ledger's total at $14.90, a harness call whose projected cost is $0.20 is refused before any model call is made, and the refusal names the cap and the current spend.
- [ ] The ledger survives across process runs: two separate invocations accumulate into one total.
- [ ] Jaccard of two empty sets is defined (1) and of disjoint sets is 0.
- [ ] `docs/audits/pro-to-flash/` is created if absent, and `git status` shows nothing under it after a run.

## M3 — Write the discovery comparison driver (~240 LOC)

**Base branch:** M2's branch
**Files owned:**
- `scripts/compare-discovery-models.ts` (new)
- `src/lib/agents/tools/web-fallback.ts` (modify: export `loadAllowlistDomains` only)

**What it does.** A manual driver for `curriculumFallback`, run as
`npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/compare-discovery-models.ts`.
It holds a fixed list of 10 `(topic, conceptTitle)` inputs in source. The list includes the
four thicken concepts from `cmuro8iil000301s6fy7bj5fq` (looked up and pinned when the block is
written). The rest are spread across the four launch topics plus operating-systems.

For each input it replays rung 1: `discoverForConceptScoped(topic, conceptTitle, 6, [],
allowDomains)` with production's allowlist. Survivors go through `runValidationPipeline` with
production's validators, and then `judgeCandidates` in memory. It records attested
candidates, validity survivors, `teaches` count, discovery-call latency (from the sink,
filtered to `curriculumFallback`) and grounding queries.

It runs the baseline twice, then the ladder with a pilot-then-project budget step, stopping
at the first arm that passes the bars in **Pass bars → `curriculumFallback`**. It prints a
summary table, with the cost per discovery call at all three price points, and writes JSONL.

**Out of scope.** Rung 2 (open web) and the YouTube prong: neither is the model call under
test. Any registry change (M4). Persisting anything.

**Migration:** none
**New deps:** none

**Tests.** None new: a live driver per `.claude/rules/testing.md`. The pure scoring it uses is
covered by M2's tests. `web-fallback.ts`'s existing tests must still pass after the export.

**Acceptance criteria.**
- [ ] Run against the local dev DB, the driver completes, and row counts of `Resource`, `ConceptResource` and `ResourceTopic` are identical before and after.
- [ ] The summary table prints, per arm: median attested, median survivors, summed `teaches`, zero-yield concepts, p50 and max discovery latency, grounding queries, and dollars per discovery call at the three price points.
- [ ] Each bar from **Pass bars → `curriculumFallback`** is printed as PASS or FAIL, with the measured value and the threshold, and the arm verdict is PASS only if every bar is.
- [ ] After a passing arm, no further ladder arm runs. After a failing arm, the next one does.
- [ ] With `discovery` spend in the ledger near its $4 allotment, the driver stops before the next input and prints the spend and the refusal. If the pilot projects fewer than 8 inputs, it stops without running the full comparison.
- [ ] The input list is a constant in the driver source, not read from argv or the DB.
- [ ] (untested at merge) A full run against production stays within the $4 allotment.

## M4 — Move `curriculumFallback` to its passing arm (~40 LOC)

**Base branch:** `main` (after M1–M7 merge and M3's run passes)
**Files owned:**
- `src/lib/ai/models.ts` (modify: the `curriculumFallback` entry and its comment)
- `src/lib/ai/models.test.ts` (modify, if it pins the entry)
- `docs/plans/pro-to-flash.md` (modify: the M3 result table)

**What it does.** `curriculumFallback` resolves to the arm that passed in M3's run. Its
registry comment is rewritten to carry the measured numbers: per-arm attested, survivors,
`teaches`, p50/max latency, and cost per call against the Pro baseline. Those are the
numbers that justify the move. It sets `callTimeoutMs: FLASH_CALL_TIMEOUT_MS` only if that
arm's max discovery latency was ≤ 30 s. The M3 result table is added to this doc under a
"Results" heading. Ships to the worker only with the combined §9 deploy.

**Out of scope.** Any other agent. The worker deploy and soak (post-merge ops). Changing
`discoveryDescriber`.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/models.test.ts` (unit) if it asserts the entry; otherwise none.

**Acceptance criteria.**
- [ ] `getModel('curriculumFallback').modelId` and its `thinkingLevel` equal the arm M3 reported as passing, and that arm's verdict line in the M3 JSONL is PASS on every bar.
- [ ] `callTimeoutMs` is set if and only if M3's max discovery latency for that arm is ≤ 30,000 ms.
- [ ] The registry comment states the measured p50 for baseline and the chosen arm, and the cost per call for both.
- [ ] No other registry entry changes (`git diff` touches only the `curriculumFallback` entry in `models.ts`).
- [ ] This doc's Results section has the M3 table, with the run date.
- [ ] If M3's run found no passing arm, this block is not implemented, and the doc records "stays on Pro" with the table.

## M5 — Write the bank comparison driver and the blind grader (~280 LOC)

**Base branch:** M3's branch
**Files owned:**
- `scripts/compare-bank-models.ts` (new)
- `src/lib/ai/models.ts` (modify: add the `compareGrader` entry to `AGENT_NAMES` and `REGISTRY`)
- `src/lib/ai/models.test.ts` (modify, if it enumerates agents)

**What it does.** A manual driver for `conceptBankAuthor`, run through `run-against-prod.ts`.
It holds a fixed list of 15 non-on-ramp concept ids in source, including concepts from
`cmuro8iil000301s6fy7bj5fq`'s path, across the launch topics. For each it loads topic,
concept title and attached resource titles/types read-only, the same fields the production
backfill passes. It then calls `authorConceptBank` per arm, at concurrency 4 to reproduce
production burst, recording 429s per arm from the sink outcomes.

Each authored bank is graded by one `compareGrader` call. The grader sees the concept title,
resource titles and the questions, but **not** the arm. It returns, per question, whether the
answer key is correct and whether the question is in scope, parsed by a zod schema. The
driver applies the bars in **Pass bars → `conceptBankAuthor`**, walking the ladder.

For the human gate it writes `blind-sample.md`: 30 questions per arm (baseline and the arm
that passed the automated bars), shuffled, labelled only by a random id. The id-to-arm map
goes in a separate `blind-key.json`. The driver doesn't print a final verdict until the user
records the human read result by re-running with `--human-read=pass|fail`.

`compareGrader` is a new registry entry: Pro, default thinking, 16384 output, with a
comment saying it is comparison-only and has no production call site.

**Out of scope.** Persisting any question. Changing `authorConceptBank`'s prompt or schema.
The move (M6).

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/models.test.ts` (unit) if it enumerates agents. The grader's zod schema
and the shuffle/key split are pure: put them in the driver's own small exported helpers only
if a unit test needs them. Otherwise none (a live driver).

**Acceptance criteria.**
- [ ] Run against the local dev DB, the driver completes, and the `ConceptQuestion` row count and every `Concept.bankAttemptedAt` are unchanged before and after.
- [ ] The grader's prompt contains no arm name, model id, or ordering that reveals the arm. Banks from all arms for one concept are graded in shuffled order.
- [ ] A grader response that fails its zod schema is retried once, then recorded as "ungraded" and excluded from the rates (counted and printed), never as correct.
- [ ] `blind-sample.md` contains no arm or model name; `blind-key.json` maps every sample id to its arm; both are under `docs/audits/pro-to-flash/`.
- [ ] Without `--human-read`, the final verdict prints as `PENDING HUMAN READ`, even if every automated bar passed. With `--human-read=fail`, the verdict is FAIL.
- [ ] The summary prints, per arm: grader error rate, out-of-scope rate, kept/authored, p50/max latency, 429 count, and dollars per bank at the three price points, each bar as PASS or FAIL.
- [ ] `compareGrader` has no call site under `src/` (grep), only in `scripts/`.
- [ ] (untested at merge) A full production run stays within the $5 allotment.

## M6 — Move `conceptBankAuthor` to its passing arm (~60 LOC)

**Base branch:** `main` (after M1–M7 merge and M5's run passes, including the human read)
**Files owned:**
- `src/lib/ai/models.ts` (modify: the `conceptBankAuthor` entry and its comment)
- `src/lib/ai/models.test.ts` (modify, if it pins the entry)
- `docs/plans/pro-to-flash.md` (modify: M5 result table and the rollback note)
- `docs/worker-deploy.md` (modify: a short rollback note under the model-retarget section)

**What it does.** `conceptBankAuthor` resolves to the arm that passed. Its comment replaces the
stale "Flash over-reached at 8 questions" claim with M5's measured rates, latency, 429 count
and cost. It sets `callTimeoutMs: FLASH_CALL_TIMEOUT_MS` only if that arm's max latency was
≤ 30 s.

The rollback note records the procedure if banks regress: redeploy the previous image, then
delete `ConceptQuestion` rows with `origin = agent` and `createdAt` ≥ the §9 deploy time on
concepts with `bankReviewed = false`. The backfill regenerates any concept with no questions
on its Path's next build. Reviewed banks are left for the operator. The deletion is a
production write and needs the user's explicit go-ahead at the time.

**Out of scope.** Any other agent. Writing a rollback script; the note describes the
operation, and a script is written only if it's ever needed.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/models.test.ts` (unit) if it pins the entry; otherwise none.

**Acceptance criteria.**
- [ ] `getModel('conceptBankAuthor')`'s model id and thinking level equal the arm M5 reported, and M5's verdict for that arm is PASS including the human read.
- [ ] `callTimeoutMs` is set if and only if M5's max latency for that arm is ≤ 30,000 ms.
- [ ] The comment no longer claims Flash over-reaches; it states M5's measured error rate, p50 and cost for baseline and the chosen arm.
- [ ] `git diff` on `models.ts` touches only the `conceptBankAuthor` entry.
- [ ] The rollback note names the `bankReviewed = false` filter and the `createdAt` window, and says the delete needs explicit approval. It references `pro-to-flash.md` by filename.
- [ ] If M5 found no passing arm, this block is not implemented, and the doc records "stays on Pro" with the table.

## M7 — Write the composer comparison driver (~250 LOC)

**Base branch:** M5's branch
**Files owned:**
- `scripts/compare-composer-models.ts` (new)

**What it does.** A manual driver for `trackComposer`, run through `run-against-prod.ts`. It
holds two fixed `spine_ready` Path ids in source: calculus and operating-systems, the latter
being `cmuro8iil000301s6fy7bj5fq`'s path. It also holds four synthetic scenarios per Path,
modelled on `compare-composers.ts`'s (exam cram, beginner, refresh-for-another-course,
grad refresh), rewritten per topic.

For each composition it calls `loadComposerMap` (read-only), then `composeTrack`, then
`validateComposition` (single-pass, `crossConceptResources: false`). It records:
- the lesson concept-sets
- `intent`
- `resourceSufficiency.enough` and whether `thinForBudget` is non-empty
- `validateComposition` primary-fallback warnings
- composer latency

The baseline runs twice, then the ladder runs with the pilot-and-budget step. Bars are those in
**Pass bars → `trackComposer`**. For the human gate it writes `composer-side-by-side.md`:
track title, summary and lesson titles/summaries for 4 compositions, baseline run 1 beside the
passing arm, labelled A/B with the key in a separate file. The verdict prints
`PENDING HUMAN READ` until `--human-read=pass|fail`.

**Out of scope.** `composer-agent.ts`. Thickening, freezing, sectioning or anything past
validation. Modifying `compare-composers.ts`. The move (M8).

**Migration:** none
**New deps:** none

**Tests.** None new: a live driver. Jaccard and stats come from M2's tested module.

**Acceptance criteria.**
- [ ] Run against the local dev DB, the driver completes, and `Track` and `Lesson` row counts are unchanged.
- [ ] The summary prints, per arm: mean Jaccard vs baseline run 1, and the baseline-run-2 yardstick beside it; thicken-decision agreement and the count of "no thicken where both baselines thickened"; fallback warnings; intent agreement; p50/max latency; dollars per composition at the three price points.
- [ ] Any composition where the arm said no thicken and both baseline runs said thicken makes the arm FAIL, whatever the other bars say.
- [ ] `composer-side-by-side.md` contains no arm or model name; the A/B key is in a separate file.
- [ ] Without `--human-read`, the verdict prints `PENDING HUMAN READ`.
- [ ] If the pilot projects fewer than 6 compositions within the $4 allotment, the driver stops without running the full comparison.
- [ ] (untested at merge) A full production run stays within the $4 allotment.

## M8 — Move `trackComposer` to its passing arm (~40 LOC)

**Base branch:** `main` (after M1–M7 merge and M7's run passes, including the human read)
**Files owned:**
- `src/lib/ai/models.ts` (modify: the `trackComposer` entry and its comment)
- `src/lib/ai/models.test.ts` (modify, if it pins the entry)
- `docs/plans/pro-to-flash.md` (modify: the M7 result table)

**What it does.** `trackComposer` resolves to the arm that passed. Its comment carries M7's
measured Jaccard against the yardstick, thicken agreement, p50/max and cost. It sets
`callTimeoutMs: FLASH_CALL_TIMEOUT_MS` only if that arm's max latency was ≤ 30 s. This also
changes `composer-agent.ts`'s model, which is not live, so it's noted in the comment rather
than tested.

**Out of scope.** Any other agent. `TRACK_COMPOSER_MODE`. The deploy and the combined soak.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/models.test.ts` (unit) if it pins the entry; otherwise none.

**Acceptance criteria.**
- [ ] `getModel('trackComposer')`'s model id and thinking level equal the arm M7 reported, and M7's verdict for it is PASS, including the human read.
- [ ] `callTimeoutMs` is set if and only if M7's max latency for that arm is ≤ 30,000 ms.
- [ ] The comment states the baseline and chosen-arm p50, the Jaccard and its yardstick, and the cost per composition.
- [ ] `git diff` on `models.ts` touches only the `trackComposer` entry.
- [ ] If M7 found no passing arm, this block is not implemented, and the doc records "stays on Pro" with the table.
