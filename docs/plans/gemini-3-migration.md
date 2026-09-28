# Gemini 3 migration

**Status:** active · **Blocks:** G1–G6; G1–G4 open as #381–#384, none merged · **Block IDs:** `G` · **Started:** 2026-09-27

## Diagnosis

**Vertex AI retires `gemini-2.5-pro`, `gemini-2.5-flash` and `gemini-2.5-flash-lite` on
2026-10-16 — 19 days from this doc.** Every model call in this repo resolves to one of the
first two. On that date, with no change, the following stop working: every course build
(spine author, spine reviewer, map reviewer, candidate judge, on-ramp author/critic, track
composer, sectioner, concept bank), the program plan pass (goal gate, topic gate,
decomposer), chat intake, web-fallback discovery and description, doc-TOC extraction, tag
canonicalization, topic classification, resource validity, and `/api/health`'s AI probe.
Embeddings are unaffected (`text-embedding-005`, a separate model family).

The migration is not a string swap, for three measured reasons:

1. **Gemini 3 wants its default temperature.** Google's migration guidance says to remove
   explicit temperature and let 3.x run at 1.0, warning of looping and degraded reasoning
   below it. Our registry sets an explicit temperature on all 25 agents, 15 of them at `0`.
   Probing `gemini-3.1-pro-preview` with the same structured-output call twice, the
   `temperature: 0` run took **112,000 ms** and the default-temperature run **4,529 ms**
   for equivalent output — one observation, but the failure mode Google describes.
2. **Thinking is now the dominant cost, and it is controllable.** Output tokens on the
   Pro-tier agents are ~87% of our recorded spend, and most of those are thinking tokens.
   On `gemini-3.7-flash`, the same structured-output call cost **385 output tokens
   (343 thinking) at default and 31 output tokens (0 thinking) with
   `thinkingConfig.thinkingLevel: 'low'`** — a 12x reduction, 3.6s → 1.4s. Our registry has
   no way to express that, so the migration either leaves the lever unused or adds it.
3. **Every `maxOutputTokens` in the registry is justified by a 2.5-specific comment.** Ten
   registry entries carry a variant of "Flash 2.5 spends the budget on internal thinking
   FIRST and emits nothing if it caps mid-thought". Those numbers were tuned against a
   model that is being removed; left unexamined they become cargo cult.

**The one non-obvious fact that shapes the whole plan: the only callable Pro-tier id is a
preview id.** `gemini-3-pro`, `gemini-3.1-pro`, `gemini-3-pro-preview` and `gemini-3-flash`
all 404 against our project. `gemini-3.1-pro-preview` works. So the seven Pro-tier agents
migrate from a model with a published retirement date to a model with no GA guarantee, and
this plan will very likely be followed by a second, smaller retarget.

## Locked decisions (this plan)

| Decision | Why |
| --- | --- |
| Pro tier → `gemini-3.1-pro-preview` | The only callable Pro-tier id; like-for-like quality successor for the authoring agents whose output is learner-facing |
| Flash tier → `gemini-3.7-flash` | A GA id (no preview exposure), verified on structured output, grounding and tool loops |
| Gate/classifier tier gets `thinkingLevel: 'low'` | Measured 12x less output and 2.6x faster on 3.7-flash; these agents apply rules, they do not reason |
| Explicit temperature is dropped for 3.x agents | Google's guidance plus the 112s outlier above; `temperature` becomes optional in the registry rather than deleted, so a future agent can still pin one |
| `thinkingLevel` lives in the registry, beside `maxOutputTokens` | It is the same kind of knob: a per-agent generation decision, not a deployment one. Consistent with the existing rule that only `modelId` is env-overridable |
| Ids change in code, not via `MODEL_<AGENT>` | The worker's env file is built by `worker-vm-startup.sh` from instance metadata and has no `MODEL_*` passthrough; an env-only migration cannot reach the worker at all |
| The three dead registry entries are deleted in the same feature | `curriculum`, `curriculumRetrieval` and `curriculumCritic` have zero call sites; migrating them would be migrating nothing |
| Validation = one live driver per tier + one full course build + one program plan | Fits the 19 days; catches schema, grounding and tool-loop regressions, which are the failures our logs do not surface as failures |
| No new dependency | The installed `@ai-sdk/google` already models `thinkingLevel` and round-trips thought signatures |

### Rejected alternatives

- **Move the Pro-tier agents to `gemini-3.7-flash`** and avoid preview ids entirely. Likely
  fine on raw capability, but the Pro agents author learner-facing artifacts that are cached
  forever (spine, on-ramp lesson, concept bank, track framing). A quality regression there
  is invisible in logs and expensive to undo, and we cannot A/B seven agents in 19 days.
- **Move the Pro-tier agents to Claude via Model Garden.** `vertexAnthropic` is already
  wired and `chatModel()` already routes `claude-*`, so it is cheap mechanically. Rejected
  for blast radius: every Pro prompt would need re-validation, and it points our
  highest-value calls away from the Google Cloud product the competition constraint rests on.
- **`gemini-3-flash-preview` for the Flash tier** ($0.50/$3, closest to today's 2.5 Flash
  price). Rejected because it is a preview id, and because `thinkingLevel: 'low'` did not
  reduce its thinking in our probe (445 output / 409 thinking, versus 31 / 0 on 3.7-flash) —
  the one lever that pays for the tier's price rise does not work on it.
- **`gemini-3.1-flash-lite` for the gate tier** ($0.25/$1.50, zero thinking by default).
  Genuinely cheaper, but it adds a third id to track, and `thinkingLevel: 'low'` *increased*
  its thinking in our probe (70 → 192 output tokens), which means the tier would need its own
  tuning story. Revisit once 3.7-flash-with-low is measured in production.
- **`gemini-3.8-flash`** (newest, callable). Rejected only because I could not confirm its
  price from a source I trust; if the check in G5 shows it at or below 3.7's, retargeting is
  a one-line follow-up.
- **Env-var-only migration** (`MODEL_<AGENT>` on Cloud Run and the VM). Rejected: see the
  locked row above. It would also leave the repo's defaults pointing at dead models.
- **Per-agent A/B across all 25 agents.** The highest-confidence option and the one that does
  not fit; it would consume the whole window and leave no room for the two deploys.

## Codebase facts (verified 2026-09-27)

Registry and resolution:

- `REGISTRY` holds **25 chat agents**; 7 on `gemini-2.5-pro`
  (`src/lib/ai/models.ts:84,108,120,162,176,190,220` — `curriculumFallback`,
  `mapSpineAuthor`, `mapSpineReviewer`, `onRampAuthor`, `onRampCritic`, `trackComposer`,
  `conceptBankAuthor`) and 18 on `gemini-2.5-flash`.
- `ModelConfig` is `{ modelId, temperature, maxOutputTokens }`, all required
  (`src/lib/ai/models.ts:37-41`); `getModel` returns them plus the resolved `model`
  (`src/lib/ai/models.ts:359-370`) and applies the `MODEL_<AGENT>` env override
  (`src/lib/ai/models.ts:361-363`).
- Embeddings are separate: `text-embedding-005`, 768 dims (`src/lib/ai/models.ts:376-379`),
  overridable via `MODEL_EMBEDDING`, and a dimension change would need a migration plus a
  full re-embed.
- **Three registry entries have no call site**: `curriculum`, `curriculumRetrieval`,
  `curriculumCritic` (grep for `getModel('<name>')` across `src`, excluding `*.test.ts`,
  returned 0 files each).
- `chatModel()` dispatches by id prefix — `claude-*` → `vertexAnthropic`, `gemini-3*` →
  `vertexGlobal`, else the regional provider (`src/lib/ai/vertex.ts:90-94`).
  `vertexGlobal` is pinned to `global` unless `GOOGLE_VERTEX_GEMINI3_LOCATION` says
  otherwise (`src/lib/ai/vertex.ts:76-83`). **No routing change is needed for `gemini-3*`.**
- `geminiFlash` (`src/lib/ai/vertex.ts:53`) has **no non-test consumer**; it appears only as
  a stub in five test files (`web-fallback.test.ts:11`, `source-concept.test.ts:12`,
  `build-track.test.ts:16`, `thicken-seam.test.ts:11`, `ensure-path-map.test.ts:14`).
- **24 non-test files call `getModel`**, each destructuring `temperature` and
  `maxOutputTokens` and passing both to `generateText`/`generateObject` (for example
  `src/app/api/health/route.ts:59-65`, `src/lib/agents/map/generate-onramp.ts:174-192`,
  `src/lib/agents/validation/validators/rules-agent.ts:35-41`).
- No call site passes `providerOptions` today (grep over `src`).

SDK support (no new dependency needed):

- Installed: `@ai-sdk/google@3.0.79`, `@ai-sdk/google-vertex@4.0.137`, `ai@6.0.191`.
- `thinkingConfig` accepts `thinkingBudget`, `includeThoughts` and
  `thinkingLevel: 'minimal' | 'low' | 'medium' | 'high'`
  (`node_modules/@ai-sdk/google/dist/index.mjs:740-745`).
- The provider reads `thoughtSignature` off assistant-part `providerMetadata` and sends it
  back on the next request (`index.mjs:578-671`, `1607-1662`), so **signatures round-trip
  automatically inside one `generateText` tool loop**. Both of our tool loops are exactly
  that shape — `generateText` + `tools` + `stopWhen: stepCountIs(...)`, SDK-managed history
  (`src/lib/agents/track/composer-agent.ts:267-278`,
  `src/lib/agents/program/decompose-agent.ts:206-212`). No manual message assembly anywhere.
- Recorded `outputTokens` already includes thinking (`candidatesTokens + thoughtsTokens`,
  `index.mjs:285-289`), so the usage numbers below are thinking-inclusive.

Grounding:

- Discovery passes `tools: { google_search: vertex.tools.googleSearch({}) }` and consumes
  `result.sources` via `resolveAttestedUrls` (`src/lib/agents/tools/web-fallback.ts:834-850`).
  The tool comes from the **regional** provider instance while a `gemini-3*` model resolves
  to `vertexGlobal`; the probe below confirms that pairing works.

Live probes against `learning-app-prod-mzw`, global endpoint, 2026-09-27:

- **404 / no access:** `gemini-3-pro`, `gemini-3.1-pro`, `gemini-3-pro-preview`,
  `gemini-3-flash`, `gemini-3-flash-lite`, `gemini-3.1-flash`, `gemini-flash-latest`.
- **Callable:** `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.5-flash`,
  `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemini-3.1-flash-lite`.
- Thinking tokens for a one-word "pong" reply: 3.1-pro-preview 96, 3.8-flash 91,
  3.7-flash 78, 3-flash-preview 60, 3.1-flash-lite 0. **The `health` agent's 512 budget
  still clears every one of them.**
- `generateObject` with a zod schema succeeded on all five probed ids. Latency,
  `temperature: 0` vs default: 3.1-pro-preview **111,968 ms vs 4,529 ms**; 3.7-flash
  3,363 ms vs 3,630 ms.
- `thinkingLevel: 'low'` on the same call: 3.7-flash **31 output / 0 thinking** (default:
  385 / 343); 3-flash-preview 445 / 409 (no reduction); 3.1-flash-lite 192 / 119 (an
  increase over its 70 / 0 default).
- Grounded `google_search` returned citations on every id probed — 10 sources
  (3.1-pro-preview), 6 (3.7-flash), 15 (3-flash-preview) — all on
  `vertexaisearch.cloud.google.com` redirect hosts, which is the shape
  `resolveAttestedUrls` already handles.
- A two-tool, multi-step loop completed on 3.1-pro-preview (3 steps, both tools called),
  3.7-flash (2–3 steps) and 3.1-flash-lite (4 steps). **One of two 3.1-pro-preview runs
  returned `finishReason: 'error'` with 1 step and no tool calls, without throwing** — cause
  unknown, and the reason G4 exercises the real loops rather than a toy one.

Cost, from recorded production usage (read-only aggregation of `CourseRequest.buildUsage`,
`Program.planUsage` and `IntakeSession.usage`, all-time as of 2026-09-16 — 9 measured
builds, 2 programs, 6 intake sessions since 2026-08-09):

- Pro-tier stages: 268,972 input / 519,173 output tokens. Flash-tier: 181,067 / 143,361.
- At 2.5 prices ($1.25/$10 Pro, $0.30/$2.50 Flash): **~$5.94**, ~$0.66 per build.
- At the chosen targets ($2/$12 Pro, $0.75/$3.75 Flash): **~$7.44, +25%**. After the Flash
  intro price doubles on 2027-01-01 ($1.50/$7.50): ~$8.12, +37%.
- Output tokens are **87% of Pro-tier cost**, which is why `thinkingLevel` is the only lever
  that matters and why the gate tier gets it first.
- This **undercounts real spend**: usage is recorded only for builds, program plans and
  intake. Map building outside a build trace, library maintenance scripts, embeddings and
  health probes are not in it. The GCP billing report is the authority.

`NEEDS VERIFICATION` — resolved in G5, read 2026-09-28 from Google's own Vertex pages.
The Vertex docs now live under the "Gemini Enterprise Agent Platform" name, and the old
`cloud.google.com/vertex-ai/...` URLs redirect there; the sources below are the redirect
targets. All prices are per 1M tokens, standard tier, ≤200K-token prompts, **Global**
endpoint (where every `gemini-3*` call goes, via `vertexGlobal`).

- **Per-token prices: confirmed, no correction.** Vertex pricing
  (<https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>) lists
  Gemini 2.5 Pro $1.25 / $10.00, Gemini 2.5 Flash $0.30 / $2.50, Gemini 3.1 Pro Preview
  $2.00 / $12.00 and Gemini 3.7 Flash $0.75 / $3.75 — exactly the figures in the cost
  section, so the **+25% (~$7.44) and +37% (~$8.12) estimates stand unchanged**. Two things
  the page adds: 3.1 Pro Preview jumps to $4 / $18 above 200K prompt tokens (no single call
  of ours comes close; `composer-agent`'s 116K is a sum across 12 steps), and non-global
  endpoints cost 10% more on the Flash models — irrelevant while `GOOGLE_VERTEX_GEMINI3_LOCATION`
  stays `global`. Grounding on Gemini 3 is billed per search query, $14 per 1,000 after
  5,000 free per month across all Gemini 3 models; the token estimate never included it.
- **`gemini-3.8-flash`'s price: identical to 3.7's.** Same page: $0.75 / $3.75 through
  2026-12-31, $1.50 / $7.50 from 2027-01-01. **Follow-up recommendation, not done here:**
  consider retargeting the fifteen Flash agents to `gemini-3.8-flash`. It is newer and is
  3.7's named replacement on the lifecycle page, but it carries the same short-term terms
  (below), so it buys no longer guaranteed runway. The practical difference is only that 3.7
  will likely receive its retirement notice first, with at least 45 days' warning. It is a
  one-line change in `models.ts`, but it needs its own G4-style live run, since nothing in
  this stack was verified on 3.8.
- **The Flash intro price and its doubling: both apply on Vertex.** The pricing page's
  banner states that Gemini 3.8, 3.7 and 3.6 Flash carry introductory pricing of $0.75 /
  $3.75 through December 31, 2026, with standard pricing of $1.50 / $7.50 from January 1,
  2027. It is a Vertex page, not a Gemini API page, and the global and non-global rows both
  double.
- **`text-embedding-005`: not affected by this deadline, but it has one of its own —
  retirement 2027-04-01.** Vertex model versions and lifecycle
  (<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions>,
  page last updated 2026-09-25) lists `text-embedding-005` (released 2024-11-18) retiring
  April 1, 2027, alongside `text-embedding-004` and `text-multilingual-embedding-002`.
  `gemini-embedding-001` is listed as available no sooner than May 20, 2028. So "Embeddings
  are unaffected" in the diagnosis is true for 2026-10 and false for 2027-04: the
  embedding-model migration deferred below is a **real deadline with a re-embed attached**,
  and needs its own plan well before April.
- **A GA Pro id: none exists.** The Gemini 3.1 Pro model page
  (<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro>,
  last updated 2026-09-25) lists only `gemini-3.1-pro-preview` and
  `gemini-3.1-pro-preview-customtools`, both "Public preview", global endpoint only, and the
  lifecycle page has no `gemini-3*-pro` text model in any table. G3's target stands.

Three lifecycle facts from the same lifecycle page bear on this plan's text; all are recorded
here and nothing is retargeted:

- **The 2.5 retirement date there is October 20, 2026**, not 2026-10-16 as the diagnosis
  says (`gemini-2.5-pro`, `gemini-2.5-flash` and `gemini-2.5-flash-lite`). Keep 2026-10-16
  as the operating deadline — whichever date is right, the worker must be on 3.x before the
  earlier one.
- **Every Flash id this stack could have picked at the 3.7 price is "short-term
  availability", not 12-month.** The locked decision calls 3.7 "a GA id (no preview
  exposure)". It is not a preview, but the page lists `gemini-3.6-flash` (2026-07-21),
  `gemini-3.7-flash` (2026-08-13) and `gemini-3.8-flash` (2026-09-02) in a separate
  short-term table, none with a retirement date announced. Such a model stays active until
  Google announces a retirement date, with at least 45 days' notice once a replacement
  exists; 3.6's and 3.7's listed replacement is `gemini-3.8-flash`. The only Flash ids with
  12-month terms are `gemini-3.5-flash` (to May 19, 2027 or later) and
  `gemini-3.5-flash-lite`. `gemini-3.5-flash` costs $1.50 / $9.00 on the Global endpoint
  (pricing page above, re-read 2026-09-28), twice 3.7's intro price and above its
  2027 price.
- **The lifecycle page's official replacements for the retiring ids:** `gemini-2.5-pro` →
  `gemini-3.5-flash`; `gemini-2.5-flash` → `gemini-3.5-flash-lite` or
  `gemini-3.1-flash-lite`; `gemini-2.5-flash-lite` → `gemini-3.1-flash-lite` or Gemma 4.
  Recorded as fact only; the locked decisions above are unchanged pending the user's call on
  lifecycle.

## G4 measured results (2026-09-28)

One run of `scripts/verify-gemini3.ts` against the **local dev DB**
(`localhost:55432/learning_app`, confirmed local by `target-guard.ts`'s `resolveTarget`
before any call), on the G3 registry. Exit 0; every probe `ok: true`; no warn or error
log line anywhere in the run; every AI call in the log finished `stop`.

**Per-agent probes** (usage is thinking-inclusive; `in / out` tokens):

| Agent | Model | ok | Usage | Notes |
| --- | --- | --- | --- | --- |
| `validityAgent` | `gemini-3.7-flash` (`low`) | yes | 898 / 158 | 3 rows → verdicts `[valid, valid, invalid]`; the listicle was rejected |
| `curriculumFallback` | `gemini-3.1-pro-preview` | yes | 366 / 3,490 | grounded: 3 sources, **3 attested** by `resolveAttestedUrls`, 1 described row (an openstax.org page), 0 unresolved redirect hosts |
| `onRampAuthor` | `gemini-3.1-pro-preview` | yes | 184 / 3,763 | 2,729 thinking + 1,034 text; 4,197-char lesson; `finishReason: stop`, far under the 32,768 cap. Direct call with the registry config — `generateOnRampResource` records no usage and swallows failures |
| `trackComposer` (`composer-agent`) | `gemini-3.1-pro-preview` | yes | 116,442 / 6,257 | **`finishReason: stop`, 12 steps, 39 tool calls**, 7 lessons |
| `programDecomposer` (`decompose-agent`) | `gemini-3.7-flash` | yes | 16,689 / 2,048 | **`finishReason: stop`, 5 steps, 10 tool calls**, no failed attempt (read from the real plan pass) |

**The intermittent `finishReason: 'error'` did not reproduce**: both real tool loops ran
once each and finished `stop`, and `decompose-agent`'s retry never fired. One clean run
is not evidence the fault is gone — the earlier probe hit it on one of two runs.

`composer-agent`'s input is ~11x the single-pass composer's because the SDK resends the
growing history every step. It is not on the production path (`TRACK_COMPOSER_MODE` is
`'single'`), but switching it on would multiply composer input cost accordingly.

**Course build** — `processCourseRequest` on a marker `CourseRequest` for `calculus` (an
existing `spine_ready` Path, so no map-building stages ran). Request `fulfilled`, Track
`ready`, `buildUsage` non-null. The composer judged resources thin, so one thicken cycle
ran (web discovery, describe, classify, judge, validate) and a second compose followed.

| Stage | Calls | G4 on 3.x (in / out) | Pre-migration, dev DB, 2.5 (in / out) |
| --- | --- | --- | --- |
| `track.composer` (Pro) | 2 | 22,701 / 15,619 | 20,955 / 20,317 (calculus 2026-07-31, also 2 calls) |
| `track.sectioner` (Flash) | 1 | 1,039 / 1,195 | 920–1,455 / 1,865–4,844 (4 calculus builds) |
| `map.candidate-judge` (Flash, `low`) | 3 | 2,213 / 326 | 794 / 1,069 for 1 call |
| `validate.rules-agent` (Flash, `low`) | 2 | 1,519 / 193 | 737–842 / 785–1,087 per call |
| `web-fallback.discovery` (Pro) | 3 | 1,893 / 14,701 | 684–688 / 3,087–5,834 per call |
| `web-fallback.describe` (Flash) | 3 | 4,348 / 4,211 | — (stage postdates the dev-DB history) |
| `topic-classifier` (Flash, `low`) | 3 | 2,832 / 257 | — (same) |
| **Total** | 17 | **36,545 / 36,502** | — |

Discovery inside the build attested 3/3, 1/1, 6/8 and 2/3 of its grounding sources (four
discovery calls including the probe); none fell back to a model-written URL.

**Program plan** — `enqueueProgram` inside a trace (a goal needing ML plus math): plan
completed, 4 topics fanned out, Program `building`, `planUsage` non-null.

| Stage | G4 on 3.x (in / out) | Pre-migration, dev DB, 2.5 (3 programs) |
| --- | --- | --- |
| `goal-gate` (Flash, `low`) | 444 / 43 | 363–406 / 48–75 |
| `plan.decompose-agent` (Flash) | 16,689 / 2,048 | 4,642–13,685 / 569–2,317 |

Decomposer input tracks library size (the prompt lists every library topic), so the
spread there is not a model effect.

**Against the +25% estimate.** One build is not comparable to the nine-build production
aggregate the estimate came from, which is where most Pro output in that aggregate went.
Four Pro registry agents were **not exercised at all** by this run: `mapSpineAuthor`,
`mapSpineReviewer`, `onRampCritic` and `conceptBankAuthor`. `onRampAuthor` was probed only
with a same-shaped prompt under its registry config, not its real system prompt. What the
run does show:

- **Like-for-like stages are flat.** The composer + sectioner + judge stages of the
  2026-07-31 calculus build cost ~$0.245 at 2.5 prices; the same stages here cost
  ~$0.241 at 3.x prices (−2%), because composer output fell 23% and the Flash stages'
  output fell sharply, offsetting the price rise.
- **The gate tier's `thinkingLevel: 'low'` lands in production code paths:** candidate
  judge ~109 output tokens per call against ~1,069, rules agent ~97 against ~785–1,087.
- **Pro discovery did not get cheaper**: ~4,900 output tokens per grounded call against
  3,087–5,834 on 2.5. It is Pro with no `thinkingLevel` (deferred by decision), so it pays
  the full +20% output price.
- The whole build: ~$0.445 at 3.x prices; the same tokens at 2.5 prices would be ~$0.353
  (+26%, price effect alone). The program plan: ~$0.021, all Flash.

Rows created (marker `__verify_gemini3__` in `CourseRequest.claimedBy` and
`Program.inputHash`, plus the Track matched by its unique goal): 1 Track, 1 CourseRequest,
1 Program (its 4 child requests cascade), all deleted in the driver's `finally`; a
post-run count found 0 left, and the `CourseRequest` status counts matched the pre-run
counts. The real seams also grew the library on their own: 1 `pending_review` agent
Resource from the thicken cycle, plus any concept-bank and `TopicAlias` writes. That is
the same growth a real build causes, and the driver leaves it in place.

## Sequencing

G1 → G2 → G3 → G4 → G5, each stacked on the previous. The split exists so that the
mechanism lands before the behavior change:

- **G1** changes the registry's shape (optional `temperature`, new `thinkingLevel`) with no
  id change, so it is reviewable as a pure refactor.
- **G2** adopts the new shape at all 24 call sites, still with no behavior change — a green
  test run here means the plumbing is right before any model moves.
- **G3** is the actual retarget: ids, dropped temperatures, gate-tier `thinkingLevel`,
  re-tuned budgets, rewritten comments. It is the block whose diff a reviewer should read
  slowly, and it is deliberately small.
- **G4** is live verification (drivers, one full build, one program plan). It cannot precede
  G3; it is what the manual gate on G3 rests on.
- **G5** is docs and the deploy runbook note.

**Deployment is not a block.** After the stack merges, the app deploys automatically via the
`deploy-main` trigger, and **the worker does not** — it needs the manual build,
`add-metadata worker-image=…`, `instances reset` sequence in `worker-deploy.md` §9. Most
model calls run in the worker, so a merged-and-not-worker-deployed state is the dangerous
one: the app would be on 3.x while the worker keeps calling a model that is about to vanish.
G5 records the ordering; the operator runs it.

## Explicitly deferred

- **Prompt simplification for Gemini 3.** Google's guidance is that 3.x with
  `thinkingLevel: 'high'` replaces chain-of-thought scaffolding in prompts. Several of our
  system prompts do that scaffolding by hand. Real wins, wrong window.
- **`thinkingLevel` on the Pro tier.** G3 sets it only on the gate/classifier agents. The
  authoring agents keep the model default until we have production numbers to tune against.
- **A move to `gemini-3.1-flash-lite`** for the cheapest agents — see Rejected alternatives.
- **Embedding-model migration.** Out of scope for this deadline, and it would carry a
  migration plus a full re-embed. Not optional, though: G5 found `text-embedding-005`
  retires 2027-04-01 (see the resolved verification list).
- **Context caching** (`cachedContent`), which the provider also exposes. The Pro-tier prompts
  repeat a lot of map context across a build and are a plausible target; not now.
- **Retiring `MODEL_<AGENT>` overrides** or wiring them into the worker's env file. The
  override stays as a local experimentation tool, not a production knob.
- **A second retarget to a GA Pro id.** Expected, and a new plan when it happens.

## Open questions for you

All three questions raised at the prose gate were answered on 2026-09-27 and are now locked:

1. **A GA Pro id, if one appears before G3 lands, wins over `gemini-3.1-pro-preview`.** G3
   re-probes the ids at implementation time and takes the GA id if it is callable.
2. **G4 runs against the dev DB only.** No production build before the worker deploy; the
   first-build check after the worker deploy (`worker-deploy.md` §11 step 1: a real request
   the worker fulfils) is sufficient.
3. **The crawler contact origin is fixed here**, as G6 — last in the stack, so it can be
   dropped without touching the migration if the window gets tight.

The `NEEDS VERIFICATION` list above was resolved in G5. What it leaves open are two
follow-ups, neither of which blocks this stack: whether to retarget Flash to
`gemini-3.8-flash` (same price, same short-term terms) or to a 12-month id, and the
`text-embedding-005` migration before its 2027-04-01 retirement.

## G1 — Make the registry express optional temperature and a thinking level (~130 LOC)

**Base branch:** `main`
**Files owned:**
- `src/lib/ai/models.ts` (modify)
- `src/lib/ai/models.test.ts` (new)
- `src/lib/ai/vertex.ts` (modify — delete the dead `geminiFlash` export)
- `src/lib/agents/tools/web-fallback.test.ts` (modify — drop the `geminiFlash` stub key)
- `src/lib/agents/track/source-concept.test.ts` (modify — same)
- `src/lib/agents/track/build-track.test.ts` (modify — same)
- `src/lib/agents/track/thicken-seam.test.ts` (modify — same)
- `src/lib/agents/map/ensure-path-map.test.ts` (modify — same)
- `.claude/rules/testing.md` (modify — the stub snippet names `geminiFlash`)

**What it does.** `ModelConfig` gains an optional `thinkingLevel` and makes `temperature`
optional, so an agent can decline to set one and run at the model's default. `getModel`
returns `temperature` as `number | undefined` and, when `thinkingLevel` is set, a ready-built
`providerOptions` object (`{ google: { thinkingConfig: { thinkingLevel } } }`) that call
sites spread straight into `generateText`/`generateObject` — the resolution stays in one
place instead of being rebuilt at 24 call sites. No agent's model, temperature or budget
changes in this block: every existing entry keeps the temperature it has today. The three
registry entries with no call site (`curriculum`, `curriculumRetrieval`,
`curriculumCritic`) and the dead `geminiFlash` export are deleted, since carrying them into
the retarget would mean migrating code nothing calls.

**Out of scope.** No call site is touched (G2 owns that), and no `modelId`, `temperature`
value or `maxOutputTokens` changes (G3 owns those). Do not add an env override for
`thinkingLevel` — the locked decision is that only `modelId` is env-overridable.

**Migration:** none
**New deps:** none — `@ai-sdk/google@3.0.79` already types
`thinkingConfig.thinkingLevel` as `'minimal' | 'low' | 'medium' | 'high'`
(`node_modules/@ai-sdk/google/dist/index.mjs:740-745`)

**Tests.** `src/lib/ai/models.test.ts` (unit, pure). It imports `@/lib/ai/models`, which
pulls in `@/lib/ai/vertex` and throws at module-eval without `GOOGLE_VERTEX_PROJECT`, so
stub the leaf per `.claude/rules/testing.md`.

**Acceptance criteria.**
- [ ] `getModel` returns every one of the 22 remaining agent names without throwing, and
      each returns a non-empty `modelId`.
- [ ] For an agent with no `thinkingLevel`, the returned object's `providerOptions` is
      `undefined`; for one with `thinkingLevel: 'low'`, it deep-equals
      `{ google: { thinkingConfig: { thinkingLevel: 'low' } } }`.
- [ ] For an agent whose config omits `temperature`, `getModel(...).temperature` is
      `undefined` (not `0`, and not a default substituted by the resolver).
- [ ] `MODEL_<AGENT>` still overrides `modelId` — setting `MODEL_HEALTH` changes the
      resolved `modelId`, and an empty or whitespace-only value falls back to the registry
      value.
- [ ] `grep -rn "getModel('curriculum')\|getModel('curriculumRetrieval')\|getModel('curriculumCritic')\|geminiFlash" src` returns no matches.
- [ ] `npx tsc --noEmit` passes with no `any`, no `as` and no `!` added to absorb the new
      optional types.

## G2 — Pass the resolved provider options at every call site (~60 LOC)

**Base branch:** `G1`'s branch
**Files owned:**
- `src/app/api/health/route.ts` (modify)
- `src/lib/agents/content/author-concept-bank.ts` (modify)
- `src/lib/agents/decomposition/concepts.ts` (modify)
- `src/lib/agents/decomposition/doctoc.ts` (modify)
- `src/lib/agents/intake/turn.ts` (modify)
- `src/lib/agents/map/candidate-judge.ts` (modify)
- `src/lib/agents/map/frontier-author.ts` (modify)
- `src/lib/agents/map/generate-onramp.ts` (modify)
- `src/lib/agents/map/review-spine.ts` (modify)
- `src/lib/agents/map/run-map-review.ts` (modify)
- `src/lib/agents/map/spine-author.ts` (modify)
- `src/lib/agents/program/decompose-agent.ts` (modify)
- `src/lib/agents/program/goal-gate.ts` (modify)
- `src/lib/agents/program/plan.ts` (modify)
- `src/lib/agents/topic-gate.ts` (modify)
- `src/lib/agents/tools/classify-topic.ts` (modify)
- `src/lib/agents/tools/web-fallback.ts` (modify)
- `src/lib/agents/track/add-frontier-concept.ts` (modify)
- `src/lib/agents/track/composer-agent.ts` (modify)
- `src/lib/agents/track/composer.ts` (modify)
- `src/lib/agents/track/sectioner.ts` (modify)
- `src/lib/agents/track/split-concept.ts` (modify)
- `src/lib/agents/validation/validators/rules-agent.ts` (modify)

**What it does.** Every `getModel` consumer destructures `providerOptions` alongside
`model`/`temperature`/`maxOutputTokens` and passes it to the SDK call, so a registry
`thinkingLevel` actually reaches the model. Behavior is unchanged in this block: no registry
entry sets `thinkingLevel` yet, so every `providerOptions` is `undefined`. `temperature`
needs no call-site change — the SDK validates it only when non-null
(`node_modules/ai/dist/index.mjs:1762`) and the provider puts it in `generationConfig`
verbatim (`@ai-sdk/google/dist/index.mjs:1509-1514`), where `JSON.stringify` drops an
`undefined`, so an unset temperature is simply absent from the request body.

**Out of scope.** No prompt, schema, budget or model id changes. A call site that already
passes its own `providerOptions` for another reason does not exist today — if the
implementer finds one, stop and report rather than merging the two objects by hand. The
`vertex.tools.googleSearch` wiring in `web-fallback.ts` stays exactly as it is.

**Migration:** none
**New deps:** none

**Tests.** No new test files. The existing colocated tests around these modules must stay
green; several stub `@/lib/ai/models`, and a stub returning no `providerOptions` key is the
`undefined` case, which is the correct default.

**Acceptance criteria.**
- [ ] Every file in **Files owned** passes `providerOptions` into its `generateText` /
      `generateObject` call — verifiable as: all 23 files listed by
      `grep -rl "getModel(" src | grep -v "\.test\.\|lib/ai/models.ts"` also contain
      `providerOptions`.
- [ ] With no registry entry setting `thinkingLevel`, a request body captured from any one
      agent contains no `thinkingConfig` key (assert via a stubbed model or the driver in
      G4, not by eyeballing).
- [ ] `/api/health` still returns `{ ok: true }` with a `usage` object against the dev
      environment, proving the spread did not break the simplest call site.
- [ ] `npm test` passes with no test file modified in this block.
- [ ] `git diff --stat` touches only the 23 files listed, and no file gains more than ~4
      changed lines.

## G3 — Retarget every agent to Gemini 3 (~90 LOC)

**Base branch:** `G2`'s branch
**Files owned:**
- `src/lib/ai/models.ts` (modify)
- `src/lib/ai/models.test.ts` (modify)

**What it does.** The seven Pro-tier agents move to `gemini-3.1-pro-preview` and the fifteen
remaining Flash-tier agents to `gemini-3.7-flash`; `chatModel()` already routes `gemini-3*`
to the global endpoint, so no provider change is needed. Every agent's explicit
`temperature` is removed so 3.x runs at its default of 1.0. The gate and classifier tier —
`topicGate`, `goalGate`, `validityAgent`, `tagCanonicalizer`, `topicClassifier`,
`conceptDeriver`, `mapCandidateJudge` — gains `thinkingLevel: 'low'`, which measured 31
output tokens against 385 on this exact kind of call. Each `maxOutputTokens` comment that
justifies its number by 2.5's thinking behavior is rewritten to say what is actually known
now, and any budget that existed only to survive 2.5's spend-then-emit-nothing failure is
re-stated rather than silently inherited. **Before editing, re-probe the ids**: if a GA Pro
id (`gemini-3-pro`, `gemini-3.1-pro`) is callable by then, it wins over the preview id.

**Out of scope.** Prompts, schemas, tool definitions and `maxOutputTokens` *values* for
agents whose comment needs no correction. Do not set `thinkingLevel` on the Pro tier or on
the authoring Flash agents (`trackSectioner`, `docTocExtractor`, `intake`,
`discoveryDescriber`, `mapReviewer`, `programPlanner`, `programDecomposer`, `health`) — deferred by
decision. Do not touch the embedding model.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/ai/models.test.ts` (unit, pure) — extend G1's suite with the tier
assertions below. No live call belongs in a unit test; the live proof is G4.

**Acceptance criteria.**
- [ ] No file under `src` contains the string `gemini-2.5` (the fixture id in
      `src/lib/ai/describe-error.test.ts:16` may stay only if it is asserting error shape,
      not model resolution; otherwise it moves to the new id).
- [ ] Every registry entry's `modelId` starts with `gemini-3`, and `chatModel(modelId)` for
      each one resolves through the global provider (assert on the id prefix, since the
      provider instance is not introspectable).
- [ ] The seven Pro-tier agents named in the prose resolve to the same single Pro id, and no
      other agent uses it.
- [ ] No registry entry sets `temperature`; `getModel(name).temperature` is `undefined` for
      all 22.
- [ ] `getModel` returns `providerOptions` with `thinkingLevel: 'low'` for exactly the seven
      gate/classifier agents listed above, and `undefined` for the other fifteen.
- [ ] Every `maxOutputTokens` in the file is either unchanged with a comment that no longer
      claims 2.5-specific behavior, or changed with a comment saying what the new number is
      for.

## G4 — Prove the migrated agents work against the live models (~170 LOC)

**Base branch:** `G3`'s branch
**Files owned:**
- `scripts/verify-gemini3.ts` (new)
- `docs/plans/gemini-3-migration.md` (modify — record the measured results)

**What it does.** A live driver, run by hand against the dev DB
(`npx tsx --env-file=.env.local scripts/verify-gemini3.ts`), that exercises one agent of
each shape rather than all 22: a structured-output agent (`validityAgent` or
`topicClassifier`), a grounded-search agent (the `curriculumFallback` discovery call,
asserting `result.sources` still yields resolvable citations), both multi-step tool loops
(`composer-agent` and `decompose-agent`), and one prose author (`onRampAuthor`). It then
drives one full course build and one program plan through the existing seams and prints the
per-stage usage snapshot so the new token profile is recorded, not guessed. Failures print
through `describeError` so a truncation is distinguishable from a schema rejection. The
driver is the evidence the manual gate on this stack rests on.

**Out of scope.** No quality scoring or golden-output comparison against 2.5 — deferred by
decision; this driver proves the calls work and records what they cost. No production DB, no
deploy. Do not convert this to a Vitest file: it costs LLM calls and needs a seeded DB,
which `.claude/rules/testing.md` puts firmly in the manual-driver category.

**Migration:** none
**New deps:** none

**Tests.** The driver itself is the test artifact; it is not a Vitest file. If any pure
helper falls out of it (usage formatting, for instance), that helper gets a colocated unit
test under `src/lib/`.

**Acceptance criteria.**
- [ ] The driver runs end to end and prints one JSON line per probed agent with
      `{ agent, modelId, ok, usage }`; every `ok` is `true`.
- [ ] The grounded discovery probe reports at least one attested URL surviving
      `resolveAttestedUrls`, and the run does not fall back to a model-written URL.
- [ ] Both tool-loop probes report `finishReason: 'stop'` with at least two steps and at
      least one successful tool call each. A run that reproduces the intermittent
      `finishReason: 'error'` seen on 3.1-pro-preview is recorded in the plan doc with its
      step count rather than retried into silence.
- [ ] One full course build completes with `status` reaching `ready`, and its `buildUsage`
      snapshot is non-null with a per-stage breakdown.
- [ ] One program plan pass completes and writes a non-null `planUsage`.
- [ ] The measured input/output token totals per stage are written into this plan doc beside
      the pre-migration numbers, so the ±25% cost estimate can be checked against reality.
- [ ] The dev-DB rows the driver creates are self-cleaning (marker-prefixed and deleted),
      per the integration-test convention.

## G5 — Document the new model targets and the deploy ordering (~70 LOC)

**Base branch:** `G4`'s branch
**Files owned:**
- `docs/ROADMAP.md` (modify)
- `README.md` (modify)
- `docs/worker-deploy.md` (modify)
- `docs/app-deploy.md` (modify)
- `docs/plans/gemini-3-migration.md` (modify — resolve the `NEEDS VERIFICATION` list)
- `docs/plans/README.md` (modify — move this plan toward archive only once G1–G5 have merged)

**What it does.** Brings the prose in the repo in line with what the code now calls: the
three docs that still name Gemini 2.5 (`ROADMAP.md`, `README.md`, and the audit doc if it
asserts current behavior rather than history) say 3.x, and the model-registry bullet in
`ROADMAP.md` gains the `thinkingLevel` knob. The two deploy runbooks get the ordering fact
this migration makes sharp: **the app auto-deploys on merge and the worker does not**, so
after this stack merges, `worker-deploy.md` §9 must be run or the worker keeps calling a
retired model. Also resolves the pricing and lifecycle checks by reading Google's own
pricing and model-lifecycle pages: confirm the per-token prices quoted in this doc, check
`gemini-3.8-flash`'s price against 3.7's, confirm whether the Flash intro price and its
2027-01-01 doubling apply on Vertex, and confirm `text-embedding-005`'s lifecycle.

**Out of scope.** No code. Do not retarget to `gemini-3.8-flash` here even if it proves
cheaper — record the finding and let it be a follow-up one-line change, since a model swap
after G4's verification run is unverified by definition. Do not rewrite the audit doc's
historical claims.

**Migration:** none
**New deps:** none

**Tests.** None (docs only).

**Acceptance criteria.**
- [ ] `grep -rniE "gemini[ -]2\.5" docs README.md` returns only statements that are
      explicitly historical (an audit finding, a shipped-phase record), with no sentence
      claiming a 2.5 model is in use.
- [ ] `worker-deploy.md` states, in the deploy section, that a merge retargeting models does
      not reach the worker until §9 is run, and names the failure it prevents.
- [ ] `app-deploy.md`'s env table still describes `GOOGLE_VERTEX_GEMINI3_LOCATION`
      accurately now that every chat model routes through the global endpoint.
- [ ] Each of the five `NEEDS VERIFICATION` items is either resolved with the figure and its
      source, or restated as still-unconfirmed with the reason.
- [ ] Docs are referenced by filename, not path, everywhere this block writes prose (CLAUDE.md
      § coding conventions), with markdown links the only exception.

## G6 — Derive the crawler contact origin instead of hardcoding it (~30 LOC)

**Base branch:** `G5`'s branch
**Files owned:**
- `src/lib/config.ts` (modify)
- `src/lib/config.test.ts` (modify)
- `src/lib/agents/decomposition/doctoc.ts` (modify)
- `AGENTS.md` (modify — the hosting section names this hardcoded string as the one place to change when a domain lands)

**What it does.** Unrelated to the model migration and last in the stack so it can be
dropped. `doctoc.ts`'s crawler `User-Agent` hardcodes the Cloud Run origin
(`src/lib/agents/decomposition/doctoc.ts:55-56`) as the contact URL site owners see in their
logs; `AGENTS.md` records it as the single string that must move when a custom domain lands.
It becomes a config-module constant that prefers `APP_ORIGIN` and falls back to the current
Cloud Run URL, so the custom-domain cutover is an env var rather than a code change. The
worker has no request to derive an origin from, which is why this reads env in
`lib/config.ts` (a leaf config module, per the env-access convention) rather than reusing
`publicOrigin`, which is request-scoped.

**Out of scope.** `publicOrigin` and `origin-check.ts` are not touched. No change to what
`doctoc` fetches, parses or decides — only the contact string in the header. Do not set
`APP_ORIGIN` anywhere as part of this block; that is an operator action at domain cutover.

**Migration:** none
**New deps:** none

**Tests.** `src/lib/config.test.ts` (unit, pure) — the fallback and the override.

**Acceptance criteria.**
- [ ] With `APP_ORIGIN` unset, the User-Agent contains
      `https://learning-app-sau6bxtxta-uw.a.run.app` exactly as today.
- [ ] With `APP_ORIGIN=https://example.test`, the User-Agent contains
      `https://example.test` and not the Cloud Run URL.
- [ ] An `APP_ORIGIN` that is not a parseable URL falls back to the Cloud Run origin rather
      than emitting a malformed header.
- [ ] `process.env` is read only in `src/lib/config.ts`; `doctoc.ts` contains no
      `process.env` reference.
- [ ] `AGENTS.md`'s hosting section names the config constant as the place the origin now
      lives, instead of pointing at `doctoc.ts`.
