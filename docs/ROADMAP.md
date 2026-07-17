# Roadmap — Adaptive Learning Path (90-Day AI Venture)

Mirrors the build order of the original spec (`learning-path-mvp-spec.md`, §9); the source of truth for what we're working on next. Edit as the project evolves.

## Status (as of 2026-07-14)

**Shipped:** Phases 1–2, the full Phase 2.5 concept-map/Track architecture (2.5a–2.5j), the Phase 2.6 course player + notebook frontend redesign (incl. landing/dashboard), Phase 2.75 multi-topic Programs with the agentic decomposer, Phase 3 auth (3a–3f), the H1–H4 creation-route hardening, the goal gate, the **chat intake agent** (`/programs/new`), operator triage surfaces (failed-builds, worker queue, pre-freeze map review), the library re-judge (sourcing provenance + library-first rung 0), and concurrent workers A–D (retry-safe queue, containerized multi-replica workers, Cloud Run deploy guide). Detail per phase below.

The product loop is complete end-to-end: a stranger lands on the notebook home page, signs in with Google, chats (or fills the scratchpad) to describe a goal, the plan pass + worker fleet builds a multi-topic Program from 100%-curated sources, and they learn in the notebook UI with exercises and persisted progress — all metered by the free-tier quota.

### ⭐ NEXT UP — Free public beta (ratings → GCP migration → observability → warm paths)

**Decided 2026-07-18**, displacing Stripe: launch as a **free beta** first. Full block-by-block plan (locked decisions, codebase facts, open questions — written so each block is workable from a fresh conversation): **[docs/free-beta-plan.md](free-beta-plan.md)**.

**1. Feature A — resource ratings** (stacked chain; live before beta users arrive):

- [ ] **A1 — schema + vote signal + trust recompute** (~120 LOC) — `ResourceRating` (resource-global ±1 per user), pure `voteSignal()` as one more `EvidenceSignal` into `computeTrustScore`, vote-time trust recompute.
- [ ] **A2 — vote API + learn-UI thumbs** (~150 LOC).
- [ ] **A3 — trust into track builds** (~80 LOC) — persisted candidates re-ranked with the attach-time coverage+trust blend in `loadComposerMap`/composers (today trust affects fresh judging only). Invariant: coverage gates, trust orders.
- [ ] **A4 — automatic low-trust eviction** (~100 LOC) — threshold (low trust + min votes) → soft-reject via `applyPendingReview` (link removal/bank staleness/readiness for free); operator restore designed-for, built later.

**2. Feature D — GCP migration** (compute to Cloud Run; **Supabase stays** for DB+auth; custom domain incoming):

- [ ] **D1 — app Dockerfile** (~60 LOC) off the existing `output: 'standalone'`; `docs/app-deploy.md` drafted.
- [ ] **D2 — Supabase schema deploy + library data migration** — `migrate deploy` (verify the two hand-written indexes), `scripts/migrate-library.ts` copying `Source`/`TopicAlias`/`Resource` local → Supabase (upserts, no embeddings — re-embed backfill after). Maps/Tracks/Programs deliberately not migrated (C rebuilds them).
- [ ] **D3 — Cloud Run app service live** (ops) — Secret Manager env, domain mapping + Supabase OAuth cutover, Vercel decommissioned.
- [ ] **D4 — Cloud Run worker pools live** (ops) — per [docs/worker-deploy.md](worker-deploy.md), against the Supabase queue.

**3. Feature B — GCP-native error reporting** (post-D3):

- [ ] **B1** (~80 LOC + console ops) — Cloud Logging `severity` mapping in `log.ts`, `/api/client-error` + global error boundary, Error Reporting alert policy. (Sentry rejected — moot once off Vercel.)

**4. Feature C — warm-path campaign** (post-D4; the cloud workers' shakedown):

- [ ] **C1 — `reset-maps` + `warm-paths` scripts** (~120 LOC) — wipe the inconsistent map/track layer (library/users kept), rebuild driver; `TOPIC_RELATIONS` additions.
- [ ] **C2 — the campaign** (ops) — rebuild 12 warm topics (existing 8 minus `go`, plus `sql`, `data-structures-algorithms`, `precalculus`, `physics-mechanics`), `/decompose` + `/review-pending-resources` passes, re-remediate to `spine_ready`.

**Beta exit criteria:** a stranger on the custom domain signs in, generates a program built by cloud workers from the warm library, learns and rates resources; errors reach Error Reporting; zero Vercel dependency.

**Deferred behind the beta:** Stripe + audit Block 5 (Block 5 still lands first when Stripe restarts — see below); audit blocks 6–10; the rest of Phase 3.1 → 2.5k–l → Phases 4–6.

<details>
<summary>Completed pre-beta hardening pass (2026-07-14 → 2026-07-17)</summary>

- [x] **Block 1 — read-layer authz + leak one-liners** (~30 LOC, PR [#240](https://github.com/mwin02/learning-app/pull/240)) — the only content-exposure hole; an afternoon.
- [x] **Block 3 — reclaim safety at N>1 workers** (~80 LOC, PR [#241](https://github.com/mwin02/learning-app/pull/241)) — was a *today* bug: the multi-replica compose workers were running with the 15m/10m reclaims firing on live jobs under the 30m deadline (duplicate builds, double spend, good Paths flipped to `failed`). Core fix config-only; plus the SIGTERM grace race and `--once` signal wiring.
- [x] **Block 2 — cost-bleeder stamps** (~120 LOC, PR [#242](https://github.com/mwin02/learning-app/pull/242)) — was the scariest bill scenario: one pathological topic on the public creation route re-ran the Pro sourcing ladder on every request, forever. Escalation cool-down (via the latest terminal RemediationJob) → fast-fail in <1s with zero model calls; `bankAttemptedAt` cool-down on empty/failed concept banks.
- [x] **Block 4 — abort threading** (~190 LOC, PR [#243](https://github.com/mwin02/learning-app/pull/243)) — makes Block 3's shutdown race terminate quickly and stops zombie pipelines burning tokens past the deadline: per-hole `throwIfAborted` + signal threading down remediation's sourcing/split/judge calls, 10s timeouts on the four googleapis fetch sites, and a `zombie-finished` log so accumulation is observable.

</details>

**Stripe (rest of Phase 3), post-beta, with Block 5 landed first:**

- [ ] **Block 5 — atomic metering** — rewrites the quota/burst/dedup checks in `program-limits.ts`, the exact file the paid gate flips inside. Land the advisory-lock helper first so tiering inherits atomicity instead of being built on the count-then-insert races.
- [ ] `app/pricing/page.tsx` — single tier, placeholder price
- [ ] `app/api/stripe/checkout/route.ts` + `app/api/stripe/webhook/route.ts` — webhook flips `User.plan = 'paid'`
- [ ] Free→paid gate enforced (free = 1 program + preview; paid = full access + tutor) — flips inside `program-limits.ts`
- [ ] Stripe **test mode** in dev

**Phase 3 exit criteria:** unauthenticated → Google sign-in → create a program (202 + programId; worker builds; visible in the notebook UI) → pricing → checkout (test card) → webhook unlocks paid features.

## Locked decisions

| Area | Choice | Why |
| --- | --- | --- |
| Niche | Tech upskillers + students (math/science) | Broad free-content pool, dual-audience landing |
| Launch topics (seeded) | Python for data/ML, JS+React, Calculus, Linear Algebra | All four have massive free-content pools to aggregate |
| AI provider | Vertex AI (Gemini) from day 1 | GCP credits available; credits don't apply to plain Gemini API key |
| DB + Auth | Supabase (Postgres + Google OAuth) | One provider for DB, auth, RLS; matches "Google sign-in only" |
| Payments | Stripe Checkout, single subscription, price TBD | Spec-mandated; revenue is a competition criterion |
| Styling | Tailwind CSS | Per spec |
| Hosting | Vercel now → Cloud Run later | Fast start; Cloud Run later adds a 2nd GCP product + uses credits |
| ORM | Prisma over Postgres (Supabase-hosted) | Per spec |
| Resource library | Postgres `Resource` table, agent-extensible | Library compounds with use; agents write vetted finds back so quality grows over time |

## Durable design records

Decisions and reversals that still bind future work; the per-phase history is in git.

- **Topic partition vs. semantic search** (PRs #44–#47) — `resource.topic` conflated _subject matter_ with _discovery context_; fixed via `TOPIC_RELATIONS` + `relatedTopics()` ([src/types/resource.ts](../src/types/resource.ts)) widening search/floor to `topic ∈ (requested ∪ related)`, a discovery topic classifier filing each find under its home topic, and a one-time backfill. Relatedness lives in a **code constant**, not a table (promote only when auto-populated at mint time — see audit 2.x below). The enum-predicate casts still defeat `@@index([difficulty])` — revisit if filtering becomes a bottleneck.
- **`pending_review → active` promotion pipeline** (`src/lib/curation/pending-review.ts` + `/api/playground/pending-resources`) — `withAdminAuth`-gated approve/reject with multi-level subtree cascade; reject records `Resource.deprecationSeverity` (`soft`=quality / `hard`=broken link), which drives Path-side candidate-deprecation (2.5g-5).
- **Tracks are immutable snapshots** (2.5g reversal) — a built Track is never patched; only the Path is kept accurate. Broken Tracks are triaged manually (`/playground/broken-tracks`).
- **Cross-provider model registry** ([#127](https://github.com/mwin02/learning-app/pull/127)) — `chatModel()` ([src/lib/ai/vertex.ts](../src/lib/ai/vertex.ts)) dispatches by id prefix (`claude-*` → Vertex Model Garden Anthropic, `gemini-3*` → global endpoint, else regional Gemini), so any `MODEL_<AGENT>` override can point an agent at Gemini 2.5/3.x or Claude with no code change.
- **Agent code layout** — agents live under `src/lib/agents/` (`curriculum/`, `map/`, `track/`, `content/`, `program/`, `intake/`, `decomposition/`, `tools/`, `validation/`); shared AI primitives (`vertex`, `models`, `embeddings`) under `src/lib/ai/`.
- **Agent architecture template** (from 2.5-AR, reused by every agent since): an autonomous tool-calling **retrieval loop** hands a fixed candidate set to a **deterministic select → critic → revise** pipeline. Patterns: hybrid search (structured filters first, vector rank within); opaque session-scoped handles (anti-hallucination); separate critic call against an explicit rubric with bounded revise; emit isolated from tools (`tools` + `Output.object` in one call silently drops structured output).

## Phase 1 — Foundation ✅

Next.js scaffold; `/api/health` calls Gemini via Vertex; Prisma `Resource` table seeded with hand-curated entries per launch topic (curation rules in [`data/README.md`](../data/README.md)); Vercel deploy live at <https://learning-app-three-amber.vercel.app/>. PRs #2–#11.

## Phase 2 — Path generation + library growth agent ✅

Original schema (`User`, `Subscription` scaffold, `Path`, `PathItem`, `EnrolledPath`, `Progress`), the library-first curriculum agent + model registry, web fallback with cache-back (`origin='agent'`, `status='pending_review'`), `POST /api/generate-path`, and the `DEV_AUTH`-gated `/playground`. PRs #14–#22. The 2b curriculum agent and `PathItem` were **retired at the 2.5g cutover**; still binding: `Path` is single-topic by design (multi-topic goals compose via Programs), and every agent resolves model config via the registry (`MODEL_*` env overrides).

## Phase 2.5 — Topic Concept Map + Track Traversal ✅

> **Redesigned 2026-06-07** around a template/instance split: **`Path` = an input-agnostic, agent-owned concept map for a whole topic** (one per canonical topic via the `TopicAlias` registry; spine = required backbone, frontier = opt-in enrichment; prerequisite DAG; per-concept candidate resources); **`Track` = a learner's immutable traversal** of that map (prunes known concepts, trims to budget, picks primaries + freezes alternates, snapshots). Why Path-scoped, not a global concept graph: global canonicalization is intractable and shared-mutable edges have no blast-radius containment; cross-topic prerequisites live at the Program layer.

### Locked decisions (still binding)

| Decision | Choice |
| --- | --- |
| Naming | `Track` = structured layer; `Lesson` = unit. Entity renaming (Path→Curriculum etc.) still deferred. |
| Decomposition | At **resource-discovery time**, cached on Resource. `course`-typed rows are container-only, never picked; atomic children link via `parentResourceId`. `decompositionStatus ∈ {atomic, decomposed, pending, unsupported, human_review}`. |
| Non-embeddable delivery | Iframe where allowed; open-in-new-tab + mark-complete where blocked. `deliveryMode` lives on `LessonResource`. |
| Concept ↔ Resource | `ConceptResource` carries a role (teaches/uses/assesses) + coverage score; candidates are `active` + `atomic`. |
| Spine-ready gate | `Path.status = spine_ready` iff every spine concept has a `teaches` candidate ≥ `MAP_SPINE_MIN_PRIMARY_COVERAGE`; otherwise the Path stays `building` and the thickener remediates. |
| Progress + enrollment | On the Track side: `Progress → lessonId`, `EnrolledPath → trackId`. 1 Path → many Tracks. |
| Invalidation | Soft/hard deprecation drops the resource from every Path's candidate pool + recomputes readiness. Tracks (immutable) may keep pointing at deprecated rows — manual triage only. |

### Shipped blocks

- [x] **2.5a — schema** (Track/Lesson/LessonResource/Exercise, decomposition columns). PR #23.
- [x] **2.5-AR — curriculum agent redesign** (PRs #24–#28): pgvector + Vertex embeddings, `searchResources` hybrid-search tool, the autonomous retrieval loop, `TopicAlias` registry + grounded canonicalization, rubric critic + bounded revise. Established the agent template (see design records).
- [x] **2.5b — decomposition pipeline** (PRs #32–#42): `decompose()` seam + routers (YouTube playlists, doc-site TOCs, `decompose_manual` for SPA courses) + the human-review curation layer. Headless-render agent decomposer for SPAs stays deferred post-Cloud-Run; the `decompose` Claude Code skill is the manual bandaid.
- [x] **2.5c/d — concept-map schema + Path builder (spine)**: `lib/agents/map/` authors cycle-validated spine DAGs, attaches library candidates, get-or-creates under a lock; 4 launch-topic spines seeded.
- [x] **2.5e — Track builder** (PRs #65–#76): compose (intent inference, conservative spine pruning, `timeWeight` grading) → validate → deterministic depth+breadth allocate → freeze. **2.5e-8** (PRs #121–#126): the tool-using composer agent behind `TRACK_COMPOSER_MODE` (`'single'` default; shares `composition-core.ts` enforcement primitives with the validator). *Cutover to `'agent'` still pending the parity gate.*
- [x] **2.5f — async thickener + spine-hole remediation** (PRs #85–#91, #93): the standing map-builder worker (frontier + alternates + hole remediation via targeted discovery), the gap-vs-conflation classifier (`splitConcept`), `RemediationJob` single-flight (partial unique index — see AGENTS.md migration warning).
- [x] **2.5g — cutover** (PRs #95–#102): durable `CourseRequest` queue (`FOR UPDATE SKIP LOCKED`) + out-of-band worker; `POST /api/generate-path` → fire-and-forget `202`; retired the 2b agent + `PathItem` (−1045 LOC); broken-tracks triage page.
- [x] **2.5h — source-quality overhaul** ([#128](https://github.com/mwin02/learning-app/pull/128)): curated-allowlist **sourcing ladder** (allowlisted sources first, open-web only on exhaustion; deny-list carries across rungs) + a real `trustScore` (`src/lib/curation/trust-score.ts` — source-reputation prior moved by precision-weighted evidence, e.g. the calibrated YouTube engagement signal) + YouTube Data API prong + trust in selection ranking. Validated cold: all four launch topics built from 100% curated sources. **Follow-up 2g shipped** (PRs [#129](https://github.com/mwin02/learning-app/pull/129)–[#137](https://github.com/mwin02/learning-app/pull/137), containment fix [#173](https://github.com/mwin02/learning-app/pull/173)): scope-aware duration ranking (`MAP_DURATION_RANKING` — over-long/too-thin resources demoted, never dropped) + the AI-generated on-ramp lesson (`generate-onramp.ts` — Pro author + accuracy critic, injected as its concept's primary via `enforceGeneratedPrimary`).
- [x] **2.5i — content agent: exercises** (PRs [#138](https://github.com/mwin02/learning-app/pull/138)–[#145](https://github.com/mwin02/learning-app/pull/145), `lib/agents/content/`): per-Concept question banks authored once at spine-readiness (on-ramp skipped) and sampled at build into frozen per-Lesson `Exercise` snapshots (no-LLM, stratified); operator discovery API (`/api/playground/concept-banks`); reveal-only PRACTICE block in the learn view.
- [x] **2.5j — delivery-mode classifier** (PRs [#151](https://github.com/mwin02/learning-app/pull/151)–[#152](https://github.com/mwin02/learning-app/pull/152), `lib/curation/embeddability.ts`): YouTube allowlist + HEAD frame-header probe cached on `Resource`; backfill classified the whole library (485/485).
- [ ] **2.5k — content agent: notebooks** *(deferred, post-launch-readiness)*: agent emits `.ipynb` via Gemini → storage → `Resource(type='interactive')` → `LessonResource`. Storage backend decided at block start.
- [ ] **2.5l — playground: map + Track render** *(deferred)*: visual concept-map (spine/frontier, edges) + built-Track rendering; build-progress UI.

### Open items for Phase 2.5

- **Segment refs for non-YouTube resources** — doc anchors need HTML-heading parsing; may need a prose fallback.
- **Pruning accuracy** — the composer prunes from free-text `priorKnowledge`/`goal`; validate on real learner inputs.
- **Discovery latency** — first cold-topic request pays decomposition cost (~30s/playlist). Accepted for now.
- **Non-embeddable circumvention** — proxy/rewrite (legal risk), agent summaries (quality risk), reader-mode extraction. Revisit later.
- **Critic-triggered re-retrieval** — the critic can only re-select over the existing set; looping back into retrieval is a future option.
- **Pre-decompose dedup (audit 6.1)** — the existing-URL skip runs *after* liveness/decompose/derivation spend; skip known URLs before validating.
- **Batch post-commit embeds (audit 7.1)** — discovery embeds one row at a time; batch via `embedMany` (backfill already does 100/call).

## Phase 2.6 — Frontend ✅

- [x] **Course player `/learn/[trackId]`** (PRs #104–#111): two-pane shell, course home (view-model in `src/lib/course-home-model.ts`), lesson view, `ResourcePane` (iframe embed with new-tab escape hatch, YouTube `/embed/` rewrite + `segmentRef` offsets). Server-side `cache()`'d `getTrackView` loader (`src/lib/track-view.ts`) instead of a public JSON endpoint. Plus two beyond-plan infrastructure wins: the **centralized design-token system** and **OS-preference dark mode** (rules in [CLAUDE.md § Styling](../CLAUDE.md)).
- [x] **Notebook frontend redesign** (PRs [#189](https://github.com/mwin02/learning-app/pull/189)–[#200](https://github.com/mwin02/learning-app/pull/200), [#206](https://github.com/mwin02/learning-app/pull/206)): program-scoped course-player routes + public program previews, program overview, persistent program shell + accordion rail, notebook course home/lesson view, my-programs dashboard, enroll page, home dashboard (goal scratchpad + continue card), activity heatmap. **Supersedes the old "2.6a landing page" item** — [src/app/page.tsx](../src/app/page.tsx) is the anonymous goal-scratchpad landing; signed-in it's the dashboard.

**Exit criteria: met** — a stranger lands, generates via the program flow, and learns in a structured notebook UI with progress.

## Phase 2.75 — Multi-topic Programs (the differentiator) ✅

A `Program` is a goal-driven plan composed of multiple single-topic Tracks. Cheap **synchronous plan pass** (topic decomposition gated by `validateTopic`; LLM weights → **deterministic** budget split; LLM-inferred phase grouping/order, presentation-only in v1 — children build in parallel), then fan-out onto the existing `CourseRequest` queue (`programId` threaded), then a worker **assembler hook** finalizes (`ready`/`partial`). Anti-list is a decomposition prompt constraint, not a resource filter. Decomposition is **grounded on the existing topic list** (whole-topic reuse only; never split a topic — a narrower need is a scope in the rationale).

- [x] **2.75a–d** — schema, `lib/agents/program/plan.ts`, fan-out + assembler, `POST /api/generate-program` (`202 { programId }`).
- [x] **2.75e — frontend** — landed as part of the notebook redesign (program routes, phased view).
- [x] **2.75f — agentic decomposer + frontier requests** (PRs [#201](https://github.com/mwin02/learning-app/pull/201)–[#205](https://github.com/mwin02/learning-app/pull/205)): Stage 1 is a tool-using agent (`program/decompose-agent.ts`) that inspects existing concept maps and records per-topic frontier-concept requests as data (`CourseRequest.frontierConcepts`); the worker executes them via `addFrontierConcept`. One-shot `decomposeProgram` kept as injectable rollback.

### Open items for Phase 2.75

- **Cross-topic seeding (pinned 2026-06-30 as "seed, deferred")** — thread earlier-phase covered concepts into later children's `priorKnowledge`; requires phase-serialized builds + coverage tracking.
- **True intra-topic subsetting (post-2.75)** — the composer treats the spine as a required floor; goal-driven spine-subsetting (e.g. calculus limited to differentiation+integration) is a new composer capability, its own block.
- **Goal modeling depth** — free-text + LLM parse may need a structured goal schema if results get fuzzy.
- **Decomposer grounding scale** — `listCanonicals()` dump inherits audit 2.1's unbounded-growth caveat; move to bounded nearby-candidate retrieval as the registry grows.
- **Practice milestones** — "implement A* on 8-puzzle" isn't a Resource; may lean on `Exercise` as auto-generated milestones.

## Phase 3 — Auth + Stripe (intentionally before tutor)

### Shipped — auth + access control (3a–3f, PRs [#183](https://github.com/mwin02/learning-app/pull/183)–[#188](https://github.com/mwin02/learning-app/pull/188))

- [x] `User.id` = Supabase auth id; `role` feeds the admin gate. Supabase Google OAuth via `@supabase/ssr`; `withAuth` verifies real JWT sessions (`DEV_AUTH` bypass dead in production builds); `withAdminAuth` is a distinct `User.role` DB check with non-enumerable 404 (**audit 9.1 closed**).
- [x] `programQuota` ([src/lib/services/program-limits.ts](../src/lib/services/program-limits.ts)) meters Program creation per user per UTC month — the ONE file Stripe tiers touch. `generate-path` demoted to admin-only; **`generate-program` is the single public creation route**.
- [x] Page gating via `getViewer`/`requireAdminPage` ([src/lib/auth/viewer.ts](../src/lib/auth/viewer.ts)); account UI + `/programs/new`; DB-backed per-user progress.

### Shipped — creation-route hardening (H1–H4, PRs [#212](https://github.com/mwin02/learning-app/pull/212)–[#215](https://github.com/mwin02/learning-app/pull/215), 2026-07-09)

- [x] **H1** — burst rate limit (`PROGRAM_BURST_PER_HOUR`) + idempotent submit (payload-hash dedup) on `generate-program`, in `program-limits.ts`.
- [x] **H2** — Origin/CSRF check on all mutating routes via the auth wrappers; AI health probe admin-gated (**audits 9.7 + 9.2 closed**).
- [x] **H3** — structured JSON logging with trace ids + per-generation token usage persisted on `Program`/`CourseRequest`.
- [x] **H4** — per-job deadline (`COURSE_JOB_DEADLINE_MS`, raised to 30m for cold builds; stale 45m) racing the pipeline, with an `AbortSignal` threaded into LLM/fetch calls (**audit 1.3 closed**).

### Shipped — goal gate (PRs [#216](https://github.com/mwin02/learning-app/pull/216)–[#217](https://github.com/mwin02/learning-app/pull/217))

- [x] `validateGoal` domain classifier as plan Stage 0 (own `goalGate` model tier) → `goal_rejected` 422 path, so off-domain goals fail fast and cheap before the plan pass.

### Shipped — chat intake agent (PRs [#223](https://github.com/mwin02/learning-app/pull/223)–[#228](https://github.com/mwin02/learning-app/pull/228), 2026-07-12)

- [x] The home-page conversation that gathers goal/background/budget and submits the **same** validated `/api/generate-program` payload as the structured form. `IntakeSession` schema + per-user message rate limits and per-conversation turn budgets designed in from the start; the agent has no privileged server path (quota/burst/validation all apply); user text delimited as untrusted data. Chat UI at `/programs/new` in the notebook style; #228 fixed cap desync / dead-ends / draft continuity.

### Shipped — operator tooling (PRs [#218](https://github.com/mwin02/learning-app/pull/218)–[#221](https://github.com/mwin02/learning-app/pull/221)) + pre-freeze map review (PRs [#207](https://github.com/mwin02/learning-app/pull/207)–[#211](https://github.com/mwin02/learning-app/pull/211))

- [x] Failed-builds triage page (list + program grouping, inline diagnosis, retry/delete) and the worker-queue monitor page.
- [x] Pre-freeze map review: critic core + `PathReview` worklist, freeze-boundary hook, operator worklist API, `review-map-findings` skill.

### Shipped — library re-judge (PRs [#229](https://github.com/mwin02/learning-app/pull/229)–[#233](https://github.com/mwin02/learning-app/pull/233), 2026-07-13)

- [x] `ResourceSourcedFor` sourcing provenance; extracted `judgeAndAttachCandidates`; decompose-time re-judge hook (new atomic children get judged against the concepts their parent was sourced for); **rung 0 — library-first sourcing** (check the existing library before any external prong); backfill script.

### Shipped — concurrent workers A–D (PRs [#234](https://github.com/mwin02/learning-app/pull/234)–[#238](https://github.com/mwin02/learning-app/pull/238), 2026-07-13)

- [x] Queue retry primitives + contention requeue + graceful shutdown; containerized worker (`Dockerfile.worker`); local multi-replica compose (`docker compose --profile workers up`); queue-depth gauge + alert/scaling docs. Cloud Run worker-pool promotion is scripted in [docs/worker-deploy.md](worker-deploy.md) — trigger: real users waiting on builds (always-on billing starts then).

### Remaining — Stripe (deferred behind the free beta)

See the checklist at the top of this file — Stripe restarts post-beta, Block 5 first.

## Phase 3.1 — Launch readiness (curriculum-agent audit)

Non-security audit findings to address before real traffic. Full audit: [docs/curriculum-agent-audit.md](curriculum-agent-audit.md).

### Codebase audit — July 2026 ✅ complete → fix blocks queued

All seven audit sections are done: [docs/audits/codebase-audit-2026-07.md](audits/codebase-audit-2026-07.md) (summary table at the top; the doc is the source of truth for finding detail). Its **[Prioritized action plan](audits/codebase-audit-2026-07.md#prioritized-action-plan)** groups the top findings into ten branch-sized fix blocks (<300 LOC each, ordered by severity × effort — cheapest high-impact first). Work them as normal feature blocks:

- [x] **Block 1 — Read-layer authz + leak one-liners** (6.1, 6.2, 1.6; ~30 LOC — PR [#240](https://github.com/mwin02/learning-app/pull/240)) — `getAuthorizedTrackView` on the /learn lesson page + `generateMetadata`; blank `requestError` in `sanitizeProgramView`; fixed string for the rejudge hook's error echo. The only content-exposure hole in the app.
- [x] **Block 2 — Cost-bleeder stamps** (3.1 High, 3.3; ~120 LOC — PR [#242](https://github.com/mwin02/learning-app/pull/242)) — escalation fast-fail with a 24h cool-down, keyed on the Path's most recent terminal RemediationJob (no new columns; subset-of-escalated-holes check, invalidated by map edits/new holes/`--force`) — stops re-running the full remediation sourcing ladder on every request for an uncoverable topic; new `Concept.bankAttemptedAt` stamped on empty/thrown bank generation so backfill skips it for 24h instead of re-paying a Pro call per request (skips visible as `cooling` in the backfill summary).
- [x] **Block 3 — Reclaim safety at N>1 workers** (2.1 High, 2.3, 2.9; ~80 LOC — PR [#241](https://github.com/mwin02/learning-app/pull/241)) — raised `REMEDIATION_JOB_STALE_MS` / `PATH_BUILD_STALE_MS` to 35m, above the 30m job deadline (ordering pinned in `config.test.ts`); proactive `requeueShutdown` after a 10s grace race on SIGTERM; signal wiring hoisted into `--once`. Also pulled Block 9's RemediationJob single-flight + parallel-claims integration tests forward. Fixed the sole High-severity correctness bug (duplicate concurrent builds).
- [x] **Block 4 — Abort threading** (2.2 + fetch-timeout inventory; ~190 LOC — PR [#243](https://github.com/mwin02/learning-app/pull/243)) — `abortSignal` threaded into `sourceAndAttachConcept`/`splitConcept` (down to their AI/web calls) + per-hole `throwIfAborted` in the remediation loop; the three smaller unthreaded sites (`generateOnRampResource`, `ensureFrontier`, `reviewAndPersistMap`) threaded too; `GOOGLEAPIS_FETCH_TIMEOUT_MS` (10s, `AbortSignal.any` with the job signal) on all four googleapis fetch sites; `course-worker.zombie-finished` log. Verified with pre-aborted signals over a synthetic Path (integration test, zero LLM spend).
- [ ] **Block 5 — Atomic metering** (1.1, 1.2, 4.1, 4.2; ~120 LOC) — per-user advisory-lock helper around program quota/burst/dedup and intake session-burst check+insert; intake turn claim as a guarded `updateMany` increment *before* the LLM call. One TOCTOU class, one helper.
- [ ] **Block 6 — Discovery upsert hardening** (5.1, 5.2; ~90 LOC) — catch P2002 as real dedup (return winner id, keep provenance), retry slug conflicts once, split `skipped` vs `failed`; pass the 120s tx timeout `decomposeExisting` already uses.
- [ ] **Block 7 — Poll-query + index hygiene** (2.6, 6.8, 7.2; ~60 LOC + migration) — `status IN (…)` on queueDepth; migration adding `@@index([state])` on RemediationJob, `@@index([status])` on Program, partial index on `Resource.decompositionStatus`, dropping `@@index([difficulty])` (hand-edit per AGENTS.md); groupBy + ROW_CAP on the two playground pages.
- [ ] **Block 8 — Small correctness batch** (4.5, 1.7, 4.3, 1.5, 1.4, 5.4; ~100 LOC) — NaN-safe `clamp01`; `.max()` on `decompose_manual` children; `slice(0, MAX_PROGRAM_TOPICS)` in planProgram; `requireSameOrigin` on signout; shared fence-delimiter sanitization; `si` param + YouTube URL canonicalization in normalize-url.
- [ ] **Block 9 — Concurrency + engine test pinning** (2.11, 3.9, 4.9, 5.8, 7.8; ~300 LOC tests) — parallel-claims, RemediationJob single-flight, concurrent intake turns, `schema-guards.test.ts` (hand-index survival), colocated suites for classify-hole / validateSplit / computeReadiness / collectSurvivors / parseJsonArray. Land before blocks 2–6 change those invariants where feasible.
- [ ] **Block 10 — Dead-code + stale-comment sweep** (3.6, 3.7, 7.3–7.5, 6.5, 6.6, 7.7; net-negative LOC) — dead config knobs/model-registry entries/`searchResourcesTool`/`supabase/browser.ts`/try-search; graveyard-stamp the five one-shot scripts; fix stale comments + logger TODOs; decide 6.5's migration path and 6.6's /learn role. Do last — pure deletion, touches files blocks 1–9 edit.

**Deliberately deferred (tracked, not blocked):** 2.5's attempts-regime split and 5.3's YouTube quota budget (both want H3 usage data to size correctly); 6.3/6.4's read-layer projection split; 3.5/2.7's `createMany` persist rewrites (fold into whichever block next touches those transactions); 7.1's prod-DB guard rails (needs its own discussion — changes the documented dev workflow).

### Topic gate + registry (audit Section 2)

- [ ] **Bounded canonical retrieval (2.1)** — `listCanonicals()` dumps every canonical into the tier-3 grounding prompt; replace with nearby-candidate retrieval (embedding/prefix) as the registry grows.
- [ ] **Canonical correction/merge tool (2.3)** — first-writer-wins makes a bad canonicalization permanent; add an admin merge/relabel utility + seed `TOPIC_SLUGS` as self-aliases.
- [ ] **Unicode-harden `normalizeTopic` (2.4)** — NFKC + zero-width stripping vs. homoglyph bypass.
- [ ] **Type `TopicAlias.subject` (2.5, nit)** — enum or check constraint instead of a free `String` cast.
- [ ] **`TOPIC_RELATIONS` maintenance** — the gate mints topics autonomously, so a missing relation can silently re-introduce the mis-filing bug. Shipped: `scripts/audit-topic-relations.ts` (reactive concept-overlap ranking; run periodically — NOT Vercel Cron). Remaining: (a) mint-time relation proposal against same-subject topics; (b) promote `TOPIC_RELATIONS` to a `TopicRelation` table + admin approval once per-relation PRs become friction; (c) richer signals (persisted cross-topic URL-collision counter, per-row cross-topic NN density).

### Web fallback (audit Section 5)

- [ ] **Stampede / global queue (5.2)** — concurrent first-requests for one cold topic each run a full discovery loop. On Cloud Run, an in-process worker-pool queue (in-flight dedup + dequeue-time threshold recheck) is viable; on Vercel, fall back to a Postgres advisory lock per topic.
- [ ] **Double-fallback + fan-out (5.3–5.5)** — dedup deterministic floor vs. discretionary fallback within one request; bound decompose concurrency; abort discovery after N consecutive empty results.

### Decomposition (audit Section 6)

- [ ] **Outbound-fetch hardening (6.2–6.4), one block** — block non-http(s) schemes + private/link-local IPs with per-redirect-hop recheck (SSRF); fetch timeout on the doc-TOC scraper; cap response reads by streaming/`Content-Length` (the 2.5j embeddability probe is already marked as a call site for the shared guard).

### Upsert & embeddings (audit Section 7)

- [ ] **`resolveSource` full-table scan (7.2)** — loads the whole `Source` table per insert; cache with TTL or add an indexed `host` column.

### Select & critic (audit Section 8)

- [ ] **Graceful-drop unknown handles (8.1)** — drop a fabricated handle instead of 422ing the whole request.
- [ ] **Renumber `order` to dense `1..N` (8.2)** — model-emitted duplicate/sparse order currently 500s at persist.
- [ ] **Deterministic `budgetFit` (8.3)** — compute pass/fail in code, not the LLM.
- [ ] **Persist the critique verdict (8.4)** — store `passedCritique` + failed criteria for queryability + quality measurement.

### Cross-cutting (audit Section 9)

- [x] **Delimit `priorKnowledge` in prompts (9.3)** — closed in place: the retrieval/select/critic prompts belonged to the 2b agent retired at the 2.5g cutover, and every surviving call site fences the free text as untrusted data (`priorKnowledge` + `goal` in both track composers, goal/background JSON-delimited in the program decomposer). Residual: the `<<< >>>` fences don't sanitize a literal `>>>` in user text — tracked as finding 1.4 in [docs/audits/codebase-audit-2026-07.md](audits/codebase-audit-2026-07.md).

## Phase 4 — Tutor agent (deep feature — spec §6)

- [ ] `lib/agents/tutor-agent.ts` — single agent, modes `tutor | quizzer | path_adjuster`
- [ ] One structured system prompt with mode switching
- [ ] Server-side context assembly per call (current lesson title + summary, outline done/next, recent perf)
- [ ] `app/api/tutor/route.ts` — `streamText` streamed
- [ ] Tutor panel in the lesson view (paid gate)

**Exit criteria:** "I don't get this" returns an answer that references the current item by name.

## Phase 5 — Adaptive branch

- [ ] `app/api/check/route.ts` — `{itemId, answers}` → `{passed, nextItemId}`
- [ ] One checkpoint in seed paths; pass → advanced, fail → reinforcement
- [ ] UI shows the branch visibly

**Exit criteria:** failing a checkpoint demonstrably routes to the reinforcement item.

## Phase 6 — Launch polish

- [ ] Progress bar, rationale visibility, empty/error states
- [ ] Migrate Stripe → live mode
- [ ] Confirm Vertex (not API-key fallback) in prod
- [ ] Public URL ready; demo recorded

**Definition of done (spec §10):** a stranger can sign up, generate a path, pay via Stripe (live), and unlock paid features with zero manual intervention; Gemini runs through Vertex; generation is agent-driven with sequenced items + rationales; context-aware streamed tutor on any item; ≥1 checkpoint adapts visibly; progress indicator; free→paid boundary enforced; deployed at a public URL.

## Out of scope (post-launch)

Native mobile, certificates, spaced repetition, multi-seat, VARK personalization. ~~Cloud Run migration is post-launch~~ — pulled forward into the free-beta plan (Feature D, 2026-07-18).

## Open items to revisit

- Final monthly price (placeholder until Stripe lands)
- Whether to add Resend (email) for transactional emails — defer unless Stripe needs it; the "course ready" email also waits on this
- ~~Whether to migrate hosting to Cloud Run before or after launch~~ — decided 2026-07-18: before (free-beta plan, Feature D)
- **Composer-agent cutover** — flip `TRACK_COMPOSER_MODE` default to `'agent'` and delete `'single'` once the parity/observability gate proves out (2.5e-8). Audit 3.6: the mode is a compile-time const, so the parity A/B can't actually run in a deployment — make it env-overridable first, and fix the agent's two tool errors that reference nonexistent tools.
- **When to move course workers to the cloud** — ~~trigger: real users waiting on builds~~ — decided 2026-07-18: scheduled as free-beta block D4 ([docs/free-beta-plan.md](free-beta-plan.md)), runbook in [docs/worker-deploy.md](worker-deploy.md).
