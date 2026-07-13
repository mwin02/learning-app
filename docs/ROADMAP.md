# Roadmap — Adaptive Learning Path (90-Day AI Venture)

This roadmap mirrors the build order from the original spec (`learning-path-mvp-spec.md`, §9) and is the source of truth for what we're working on next. Edit as the project evolves.

## Status (as of 2026-07-08)

**Shipped:** Phases 1, 2, the full **2.5-AR curriculum-agent redesign**, the **topic partition vs. semantic search** redesign (Blocks 1/2b/2a/3, PRs #44–#47), the `pending_review → active` **promotion pipeline**, the **Phase 2.5 concept-map / Track-traversal** rebuild through the **2.5g cutover** (Path = per-topic concept map, Track = immutable learner traversal; the async worker builds Tracks off a durable `CourseRequest` queue), the **2.5h source-quality overhaul** (curated sourcing ladder + a real `trustScore`, [#128](https://github.com/mwin02/learning-app/pull/128)), the **Phase 2.6 course player** (`/learn/[trackId]`, PRs #104–#111) — a read-only Track delivery UI with a centralized design-token system + OS-preference dark mode, and the **2.5i content agent — exercises** ([#138](https://github.com/mwin02/learning-app/pull/138)–[#145](https://github.com/mwin02/learning-app/pull/145)): per-Concept question banks (Pro-authored, amortized) sampled into per-Lesson `Exercise` snapshots, an operator discovery API, and a reveal-only PRACTICE block in the lesson view. The playground generates real sequenced Tracks end-to-end, and built Tracks render as a structured, dark-mode-aware course with embed/new-tab resources, **practice exercises**, and anonymous progress. Since then: **Phase 2.75 Programs** (2.75a–f — goal → multi-topic Program via the plan pass + CourseRequest fan-out + worker assembler; the agentic decomposer with frontier-concept requests landed as PRs [#201](https://github.com/mwin02/learning-app/pull/201)–[#205](https://github.com/mwin02/learning-app/pull/205)), **Phase 3 auth** (3a–3f, PRs [#183](https://github.com/mwin02/learning-app/pull/183)–[#188](https://github.com/mwin02/learning-app/pull/188) — real Supabase sessions, role-based admin gate, free-tier program quota, route/page protection, account UI, DB-backed progress), the **notebook frontend redesign** (PRs [#189](https://github.com/mwin02/learning-app/pull/189)–[#200](https://github.com/mwin02/learning-app/pull/200) — landing/dashboard, program/course/lesson views, enrollment), and the **pre-freeze map review** critic + operator worklist (PRs [#207](https://github.com/mwin02/learning-app/pull/207)–[#211](https://github.com/mwin02/learning-app/pull/211)).

**Design records carried forward (durable):**

- **Topic partition vs. semantic search** (PRs #44–#47) — `resource.topic` conflated _subject matter_ with _discovery context_; fixed via `TOPIC_RELATIONS` + `relatedTopics()` ([src/types/resource.ts](../src/types/resource.ts)) widening search/floor to `topic ∈ (requested ∪ related)`, a discovery topic classifier filing each find under its home topic, and a one-time backfill (247 rows relabeled). Relatedness lives in a **code constant**, not a table (promote only if relations are auto-populated at mint time — see [audit 2.x](#topic-gate--registry-audit-section-2)). The **subject ceiling** is the relation bound, not the coarse `subject` field. `WHERE topic IN (…)` rides the existing `@@index([topic, status, tier])` prefix; the `col::text = …` enum-predicate casts still defeat `@@index([difficulty])` — revisit if filtering becomes a bottleneck.
- **`pending_review → active` promotion pipeline** (`src/lib/curation/pending-review.ts` + `/api/playground/pending-resources`) — closed audit 5.1's gap (nothing promoted discoveries to `active`). `withAdminAuth`-gated approve (→`active`) / reject (→`deprecated`), multi-level subtree cascade via a recursive CTE, race-safe conditional updates. Reject records `Resource.deprecationSeverity` (`soft`=quality / `hard`=broken link) — the field the Track layer branches on; the referencing-row cleanup it once did on `PathItem` is now **Path-side candidate-deprecation** (2.5g-5, [#99](https://github.com/mwin02/learning-app/pull/99)).

### ⭐ NEXT UP — Pre-launch hardening → chat intake agent

**Phase 3 auth: SHIPPED** (3a–3f, PRs [#183](https://github.com/mwin02/learning-app/pull/183)–[#188](https://github.com/mwin02/learning-app/pull/188)). `withAuth` verifies real Supabase JWT sessions; `withAdminAuth` is a distinct `User.role` check (audit 9.1 ✅); Program creation is metered per user per month (`programQuota`); pages are gated via `getViewer`; `POST /api/generate-path` is demoted to admin-only, making `POST /api/generate-program` the single public creation route. See the [Phase 3 checklist](#phase-3--auth--stripe-intentionally-before-tutor).

**Next: the creation-route hardening blocks (H1–H4)** — burst rate limit + idempotency, Origin/CSRF check + health-probe gate, per-generation cost observability, worker job deadline. These are the security/architecture prerequisites for the **chat intake agent**: the home-page conversation that gathers goal/background/budget and submits the _same_ `/api/generate-program` payload the 3e form does (the form was built as its structured stand-in). Chat intake is its own feature after H1–H4; its per-message LLM spend needs its own rate limit, designed in from the start.

**Then:** Stripe (rest of Phase 3) → Phase 3.1 launch readiness → 2.5k–l (content agent: notebooks + playground map — deferred, not dropped) → 4–6.

**2.5j — Delivery-mode classifier: SHIPPED** (PRs [#151](https://github.com/mwin02/learning-app/pull/151)–[#152](https://github.com/mwin02/learning-app/pull/152)). Per-`LessonResource` `deliveryMode` is now set from a YouTube allowlist + runtime frame-header probe cached on `Resource`, with an idempotent library backfill — built Tracks embed where framing is safe and fall back to new-tab where it isn't. See the [block checklist](#block-sequence-each-300-loc-one-pr-per-block) for the architecture.

**2.5i — Content agent (exercises): SHIPPED** ([#138](https://github.com/mwin02/learning-app/pull/138)–[#145](https://github.com/mwin02/learning-app/pull/145)). Per-Concept question banks (Pro-authored at spine-readiness, on-ramp skipped) sampled into per-Lesson `Exercise` snapshots at build, plus an operator discovery API and the reveal-only PRACTICE block in the learn view — the first content a learner can _act on_. See the [block checklist](#block-sequence-each-300-loc-one-pr-per-block) for the architecture.

**Agent code layout:** agents live under `src/lib/agents/` (curriculum pipeline in `agents/curriculum/`, tools in `agents/tools/`, web-discovery validation in `agents/validation/`); shared AI primitives (`vertex`, `models`, `embeddings`) under `src/lib/ai/`. New agents (`decomposition`, `track`, `content`, `program`, `tutor`) land under `agents/`.

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
| Resource library | Postgres `Resource` table, agent-extensible | Library compounds with use; the Phase 2 agent writes vetted finds back so quality grows over time |

## Phase 1 — Foundation ✅

Runnable Next.js scaffold + repo conventions + Vertex/Gemini proven end-to-end.

- **1a** — `/api/health` calls Gemini via Vertex (`ai` + `@ai-sdk/google-vertex`); GCP project + service account set up.
- **1b** — Postgres `Resource` table (Prisma) seeded with ~10 hand-curated entries per launch topic (39 total). Growth-loop schema (`slug`, `topic`, `title`, `url`, `type`, `tier`, concepts, `origin` seed/agent/user, `status`). Curation rules in [`data/README.md`](../data/README.md). PRs #2–#4.
- **1c** — Vercel deploy; prod `/api/health` works; prod DB migrated + seeded. Live at <https://learning-app-three-amber.vercel.app/>. PRs #10, #11.

## Phase 2 — Path generation + library growth agent ✅

- **2a** — Prisma schema: `User` (minimal), `Subscription` (scaffold), `Path` (nullable `createdBy` FK, input snapshot), `PathItem`, `EnrolledPath`, `Progress`. PR #14.
- **2b** — Curriculum agent (library-first) + model registry (`src/lib/ai/models.ts`); Gemini sequencing + per-item rationale. PR #17.
- **2c** — Web fallback (Vertex-grounded Google Search when topic ∉ seeded set or candidates < threshold) + cache-back as `Resource(origin='agent', status='pending_review')` + LLM tag canonicalization + per-topic ≥10-active gate + discover/validate validity loop. PRs #18, #19.
- **2d** — `POST /api/generate-path` + `PathService`; single-transaction persist; hardened vs agent cuid hallucination. PRs #20, #21.
- **2e** — Agent playground (`/playground`), `DEV_AUTH`-gated, with raw-JSON inspector. PR #22.

**Constraints still binding future work:**

- `Path` is **single-topic by design**; multi-topic goals compose Paths via a `Program` layer (Phase 2.75). _(Still binding — a Track traverses one Path = one topic.)_
- `EnrolledPath` is a separate join table; `Subscription` is its own table (populated in Phase 3).
- Every agent resolves model config via the registry (`MODEL_*` env overrides). The registry now resolves model ids **across providers** ([#127](https://github.com/mwin02/learning-app/pull/127)): `chatModel()` ([src/lib/ai/vertex.ts](../src/lib/ai/vertex.ts)) dispatches by id prefix — `claude-*` → Anthropic partner models (Vertex Model Garden, own location, default `global`), `gemini-3*` → the `global` Gemini endpoint (3.x isn't served regionally), else → the default regional Gemini provider — all on the same GCP project/service account/credits. So a `MODEL_<AGENT>` override can point any agent at Gemini 2.5/3.x or Claude with no code change (the model must be enabled in Model Garden); defaults are untouched (`trackComposer` stays `gemini-2.5-pro`).

> _(The Phase-2 `Path` generation-input + `createdBy` constraints were **reversed** by the Phase 2.5 redesign — Path is now an agent-owned per-topic concept map; details in that section.)_

**Why Phase 2.5 exists:** a Path of curated links is the right _generation_ artifact but not the right _delivery_ one (whole-course resources overlap, and links into external sites kill progress tracking + tutor context) — so a **Lesson layer** for structured, lesson-by-lesson delivery sits above it. That is Phase 2.5.

## Phase 2.5 — Topic Concept Map + Track Traversal

> **Redesigned 2026-06-07.** The original "Structured Track Agent" treated `Track` as a 1:1 dedup wrapper over a _user-specific_ `Path`. A design pass reconceived the two layers around a **template/instance split**: `Path` becomes an **input-agnostic concept map for a whole topic**; `Track` becomes a **learner's immutable traversal** of that map. Resource invalidation, per-learner personalization, and the 2.75 Program layer all fall out more cleanly. The shipped foundations (2.5a schema, 2.5-AR curriculum agent, 2.5b decomposition) are unchanged and still load-bearing; only the _delivery_ layer (old 2.5c–g) and its Track-layer decisions are replaced.

### The model

- **`Path` = a topic's concept map** — input-agnostic, agent-owned, **one per canonical topic** (keyed via the `TopicAlias` registry). Holds Path-scoped `Concept` nodes + a prerequisite **DAG** between them + per-concept **candidate resources**. Each concept carries `spine | frontier` membership: the **spine** is the required backbone, the **frontier** is opt-in enrichment. A living asset the map-builder maintains.
- **`Track` = a learner's immutable traversal** of a Path. Walks the spine sub-DAG, prunes concepts the learner already knows, trims to the time budget, pulls in frontier concepts as budget allows, picks one **primary** resource per Lesson and freezes the runners-up as **alternates**, generates exercises, and **snapshots**. Carries the per-learner inputs + user-facing title/summary.
- **Invalidation policy** (drives `Resource.deprecationSeverity`, already shipped): both `soft` (quality downgrade) and `hard` (dead link) → drop the resource from every Path's candidate pool (delete its `ConceptResource` links) + recompute readiness; future Track builds won't pick it, and a hard reject that empties a spine concept regresses the Path `spine_ready → building` for the worker to refill. **~~`hard` also reaches into live Tracks to promote an alternate / flag the LessonResource.~~ — reversed in 2.5g.** Tracks are **immutable snapshots**: a built Track is never patched and may keep pointing at a deprecated Resource (the row still exists). Only the Path is kept accurate; broken Tracks are triaged manually (`/playground/broken-tracks`). Immutability is now of the whole Track snapshot, not just its learning structure.
- **Why Path-scoped, not a global concept graph:** a global graph needs library-wide concept canonicalization (the `TopicAlias` problem one level down, far worse) and shared-mutable edges with no blast-radius containment. Path-scoped nodes trade cross-topic concept reuse for tractability + containment + cheap subgraph snapshotting. Cross-topic prerequisites get an explicit home at the Program layer instead of leaking through traversal.

### Locked decisions — carried forward from original 2.5 (decomposition; unchanged)

| Decision | Choice |
| --- | --- |
| Naming | `Track` for the structured layer; `Lesson` for the unit. Avoids collision with "course" as a resource type. |
| Where decomposition lives | **Resource-discovery time, not build time.** Decomposed once, cached on Resource forever. |
| Container resources | `course`-typed Resources are **container-only** — never picked. Atomic children link via `parentResourceId` + `orderInParent`. |
| Decomposition router | YouTube playlists (Data API) + doc-TOC scrape + "single = atomic"; paid platforms out of scope; unsupported → `human_review`. |
| Decomposition status | `Resource.decompositionStatus ∈ {atomic, decomposed, pending, unsupported, human_review}`; atomic + decomposed-children pickable. |
| Concept re-derivation | Decomposed children re-derive `conceptsTaught` from their own content, not inherited slices of the parent's. |
| Non-embeddable delivery | Iframe where allowed; **open-in-new-tab + "mark complete"** where blocked. `deliveryMode` lives on `LessonResource`, not `Lesson`. |
| Where exercises live | `Exercise` attaches to `Lesson`. Notebooks become `Resource(type='interactive', origin='agent')`, linked via `LessonResource`. |

### Locked decisions — this redesign (supersedes the original Track-layer decisions)

| Decision | Choice |
| --- | --- |
| Path's role | **Input-agnostic concept map for a whole topic**, not a per-request user artifact. One Path per canonical topic; agent-owned. Loses `createdById`, `difficulty` (now per-resource), the `input*` snapshot, and its user-facing title. |
| Concept representation | **Path-scoped `Concept` nodes** with a stable per-Path slug. Canonicalization is a _within-one-map_ match-or-create on thicken (tractable), never global. |
| Ordering | A **prerequisite DAG** of intra-Path `ConceptPrereq` edges (cycle-validated). The _linearization_ (topo-sort) is a Track-build concern, not stored on Path. |
| Scope bounding | **Core spine + opt-in frontier.** Track quality keys on a complete _spine_, not a complete map; the frontier thickens over time. |
| Concept ↔ Resource | A `ConceptResource` link carrying a **role** (teaches/uses/assesses) + a **coverage/quality score**, so the builder can pick a primary and rank alternates. Candidates are existing pickable rows (`active` + `atomic`). |
| Track ↔ Path cardinality | **Drop `Track.pathId @unique`** (1 Path → many Tracks). FK topology is fixed: `EnrolledPath → trackId`, `Progress → lessonId`. The **flavor** (per-enrollment snapshot vs. per-version) is _deferred_ — both satisfy the same FKs. |
| Where progress + enrollment live | **On the Track/instance side.** `Progress` keys on `lessonId` (the completable unit); `EnrolledPath` references the pinned `trackId`. `Path`/`PathItem` become a pure generation artifact the learner never touches. |
| Alternates' origin | **Byproduct of per-concept candidates.** Track picks a primary from a concept's candidates and freezes the rest as `role='alternate'`. No separate alternate-sourcing step. |
| Thin-then-thicken vs. immutability | **The spine builds synchronously and gates the first Track**; only frontier concepts + extra candidate resources (the alternates) thicken async. A Track frozen during the thin window is always _spine-complete_ — just alternate-thin — never broken. |
| Spine-ready gate | `Path.status = spine_ready` iff every spine concept has a `teaches` candidate at/above the coverage floor (`MAP_SPINE_MIN_PRIMARY_COVERAGE = 0.5`); otherwise it's a _spine hole_ and the Path stays `building`. Never green-lights a Track with an unteachable node. |
| Spine-hole remediation | An async worker fills holes on a `building` Path via targeted per-concept discovery → re-judge → re-attach (the **2.5f thickener**). Exhaustion: relax the bar (accept best `uses` / below-floor `teaches`), then escalate to the review queue + page a dev. |
| Map maintenance | A **map-builder** agent is a _standing_ job (build spine, then thicken + attach new finds), distinct from the per-request **track-builder**. Both reuse the AR hybrid-control-flow template. |
| `PathItem` fate | **Retired at cutover.** `Concept`/`ConceptPrereq`/`ConceptResource` replace its role as the curriculum record. `Lesson`/`LessonResource`/`Exercise` (from 2.5a) are kept as-is — the Track's delivery shape. |
| Entity renaming | **Deferred.** Internally "Path" now means "concept map" and "Track" the user's plan — colloquially the reverse. Whether to rename (e.g. Path→`Curriculum`, Track→`Path`) is decided before there's a public UI to break, not now. |

### Completed

- [x] **2.5a — Schema additions** (migration `20260528…track_lesson_decomposition` + playground inspector). `Resource` gains `parentResourceId` (self-FK), `orderInParent`, `decompositionStatus`. New models `Track`, `Lesson`, `LessonResource` (`role`, `deliveryMode`, `segmentRef?`), `Exercise`. PR #23.

#### Phase 2.5-AR — Curriculum Agent Redesign ✅

The 2b agent was a single `generateText` call that dumped a topic's whole library into the prompt and picked by positional index. 2.5b breaks that (decomposition explodes containers into dozens of atomic children), so AR turned the agent into a multi-step, tool-calling agent.

**Architecture (now the template for the Track / Content / Program / Tutor agents):** an autonomous tool-calling **retrieval loop** (the model decides when to search, broaden, or fall back) hands a fixed candidate set to a **deterministic select → critic → revise** pipeline that emits the customer-facing artifact. Agentic where flexibility pays; auditable where correctness matters.

**Shipped (PRs #24–#28):** pgvector + Vertex embeddings on `Resource` (embed-on-insert + `scripts/embed-resources.ts` backfill); `searchResources` hybrid search (structured filters → vector rank, ≤30 load-all) as an AI SDK `tool()`; the autonomous retrieval loop over opaque session-scoped handles; deterministic select → emit; the `TopicAlias` registry + grounded canonicalization; and the rubric critic + bounded revise loop with a full-pipeline agent trace in the playground.

**Patterns now established (reuse for future agents):**

- **Hybrid control flow** — autonomous loop for retrieval; deterministic pipeline for output.
- **Hybrid search, never pure vector** — structured filters (`topic`, `status`, pickability) first, then vector rank within that set; ≤30 candidates → return all.
- **Opaque handles** — tools return short session-scoped IDs; any submitted ID is validated against what was actually returned this session (replaces the positional-index anti-hallucination trick).
- **Separate critic call** against an explicit rubric → bounded revise (not self-grading in the same context).
- **Emit isolated from tools** — combining `tools` + `Output.object` in one call silently drops structured output, so emit is a separate `Output.object` call with no tools over the gathered candidate set.

#### Phase 2.5b — Decomposition pipeline ✅

Container resources (playlists, doc trees, whole courses) are decomposed into atomic, pickable child Resources at discovery/seed time, plus a human/agent curation layer for containers the routers can't (or won't) auto-explode. Code lives under `lib/agents/decomposition/` (router → `decompose()` orchestrator → per-source routers → shared `upsertResource`/`decomposeExisting` sink), not the single `decomposition-agent.ts` originally sketched.

**Shipped (PRs #32–#42):** the `decompose()` seam + `atomic` fast-path (shared by discovery + seed); routers for YouTube playlists (Data API), doc-site TOCs (LLM-selected anchors), and **manual** decomposition (`decompose_manual` for client-rendered SPA courses); seed backfill + oversize gate (`DECOMPOSITION_MAX_AUTO_CHILDREN=50` → `human_review`); and a **curation layer** beyond the original sketch — a `withAdminAuth`-gated review API (`accept_atomic`/`reject`/`decompose`, agent-first discriminated-union body + `reason` passthrough) with per-row buttons on the `/playground/human-review` queue.

- **SPA / headless escape hatch (forward-looking).** Khan-style SPAs render lessons client-side, so the scrape routers park them in `human_review`; `decompose_manual` lets a human or browser agent supply the ordered lessons (verified by driving a headless browser over Khan's Linear Algebra course — 138 ordered, concept-tagged children). The proper fix — a **headless-render agent decomposer** that POSTs `decompose_manual` itself — is deferred to post-Phase-3 (keeps a Playwright/Chrome dependency off Vercel; see [open items](#open-items-for-phase-25)). Until then the `decompose` Claude Code skill (browser-spa route) is the manual bandaid.

Carried into the Path builder (2.5e): prefer **same-parent cohesion** when attaching sibling atomic children as concept candidates.

> **Data model:** all the 2.5 schema changes (`Concept` / `ConceptPrereq` / `ConceptResource`; `Path` → `{ topic, status }` + concept-map relations; `Track` drops `pathId @unique` + gains learner inputs; `EnrolledPath → trackId`; `Progress → lessonId`; `PathItem` retired) **shipped across 2.5c–g** — see `schema.prisma` for the current source of truth.

### Builders

- **Path builder (map-builder)** — per topic: authors the spine `Concept`s + prereq edges (cycle-validated), attaches existing-library candidates as `ConceptResource`s with role + coverage. Spine build is **synchronous** (gets-or-creates the Path under a lock so concurrent first-requests don't double-build) and sets the Path `spine-ready`. Frontier concepts + extra candidates **thicken async**. Launch-topic spines are seeded. Concept canonicalization is a within-map match-or-create.
- **Track builder** — per request over a `spine_ready` Path: **compose** (one Gemini-2.5-Pro pass — infer `intent`, prune known concepts incl. spine, choose frontier depth, grade each lesson into a `timeWeight` + ranked mandatory core + optional pool) → **validate** (inclusion-closure, DAG order, ≥1-resource fallback) → **allocate** (deterministic: `timeWeight × budget` → per-lesson minute slices, fill the core rank-first into multiple `primary`s, trim frontier breadth closure-aware) → emit ordered `Lesson`s (multiple `primary` + frozen `alternate` pool) → fan out exercises → freeze. (The single-primary/budget-blind first cut was redesigned mid-phase; see 2.5e.)

### Block sequence (each <300 LOC, one PR per block)

- [x] **2.5c — Additive schema + inert re-keys.** The new `Concept`/`ConceptPrereq`/`ConceptResource` tables + Track/`EnrolledPath`/`Progress` re-keys, landed alongside the still-live `Path`/`PathItem`. Migration + Prisma client only.
- [x] **2.5d — Path builder: spine.** `lib/agents/map/` authors canonical spine concepts + cycle-validated prereq edges, attaches library candidates, get-or-creates the Path under a lock, sets `spine_ready`; 4 launch-topic spines seeded; map inspector.
- [x] **2.5e — Track builder** (PRs #65–#76). `lib/agents/track/`: compose → validate → allocate → freeze an immutable Track (pipeline detail in [Builders](#builders)). Adds `Track.targetMastery`, conservative spine pruning, free-text-`goal` → `TrackIntent`, and the depth+breadth allocator. Drove three fixes from real calculus Tracks: budget-blind selection, no spine pruning, no notion of intent.
  - [x] **2.5e-8 — Tool-using composer agent** (PRs #121–#126, flag-gated, **dormant by default**). Reworked the one-shot `composer.ts` into an agentic alternative (`composer-agent.ts`) selected by `TRACK_COMPOSER_MODE` (`'single'` default → production unchanged until the cutover gate). Same `ComposerResult` contract, so validate → allocate → freeze downstream is identical and the two composers are A/B-swappable. Blocks: **(1)** `omitForIntent` — intent/target-mastery-driven concept omission (a cram drops the intro floor the audience already has) folded into the same excluded set as `prune` but kept separable in the trace ([#121](https://github.com/mwin02/learning-app/pull/121)); **(2a)** extracted the LLM-free enforcement primitives into `composition-core.ts` (`buildPrereqIndex`/`computeInclusion`/`assignConceptsToLessons`/`orderConceptSlugs`) so the live agent tools and the post-hoc validator share one closure and can't drift ([#122](https://github.com/mwin02/learning-app/pull/122)); **(2b)** the `generateText` tool loop over a server-side draft (`get_map_overview`/`get_concept_candidates`/`exclude_concept`/`add_lesson`/`finalize`) with live "still-unplaced" feedback from the 2a primitives — enforcement stays downstream, opaque `r#` handles carry the anti-hallucination ([#123](https://github.com/mwin02/learning-app/pull/123)); **(2c)** `search_candidates` + opt-in `crossConceptResources` validation flag, letting the agent re-purpose the whole-Path candidate pool by intent (e.g. an `assesses` resource attached elsewhere); off by default so single-pass resolution is byte-identical ([#124](https://github.com/mwin02/learning-app/pull/124)); **(2d)** observability (shared `AgentTracePanel`, always-on build-track trace) + a `compare-composers.ts` parity harness across the four calculus intents — the cutover gate ([#125](https://github.com/mwin02/learning-app/pull/125)); and a finalize-miss fix — synthesize real framing from the built lessons instead of freezing a bland `"<topic>"` title, search-only-when-needed, `TRACK_COMPOSER_MAX_STEPS` 40→60 ([#126](https://github.com/mwin02/learning-app/pull/126)). **Remaining before cutover:** flip `TRACK_COMPOSER_MODE` default to `'agent'` and delete `'single'` only after the parity/observability gate proves out; the 2c finding that the calculus pool has almost no `assesses` resources points at Tier-2 thickener discovery as the highest-value follow-on.
- [x] **2.5f — Async thickener + spine-hole remediation** (PRs #85–#91, #93). The standing map-builder worker: adds frontier concepts + alternates after the spine, remediates `building`-Path spine holes, and handles hard-deprecation regressions (same operation — targeted per-concept discovery via `web-fallback.ts` → validate/upsert/embed → re-attach + re-judge → recompute readiness — differing only in trigger). Evidence-based **gap-vs-conflation** classifier: a _genuine gap_ is sourced; a _conflation hole_ (an over-coarse concept whose candidates each cover a different slice) is **split into finer nodes** (`splitConcept`, bounded iterative loop) rather than sourced — the reliable backstop behind the builder's title-based granularity reviewer. Plus `addFrontierConcept` (dedup/relevance-gated on-demand enrichment) + CLIs. Job infra: Postgres job table + `RemediationJob` single-flight (partial unique index); **exhaustion** relaxes the bar, then escalates to the review queue + pages a dev.
- [x] **2.5g — Cutover** (PRs #95–#102). Repointed the create flow off the old `PathItem` curriculum agent onto the concept-map/Track pipeline and retired the dead subsystem: a durable `CourseRequest` queue (`FOR UPDATE SKIP LOCKED`) + `ensurePathMap` reclaim of non-self-healing Paths + an out-of-band worker (`scripts/course-worker.ts`, `--watch`/`--once`, no Vercel Cron); fire-and-forget `POST /api/generate-path` → `202 { requestId }`; reject pipeline repointed to Path-side candidate-deprecation; retired the old retrieval subsystem (−1045 LOC) + `PathItem`/`PathItemStatus`/the Path user columns (`Path` is now `{ topic, status }` + concept-map relations); broken-tracks triage page (`/playground/broken-tracks`).
  - **Design reversal — live-Track reach dropped.** The original scope had a hard reject _reach into live Tracks_ (promote a frozen alternate / flag the `LessonResource`). Reversed: **Tracks are immutable snapshots of a Path** (recorded in `schema.prisma`). Only the _Path_ is kept accurate; a built Track may keep pointing at a since-deprecated Resource and is triaged **manually** via the triage page rather than auto-healed. (Removed the `LessonResource` `flagged`-state work the original scope implied.)
  - **Still deferred:** the "course ready" email (Phase 3 — needs `User.email`; the worker logs the Track to stdout meanwhile), and folding pre-existing unlinked `pending_review` rows into the re-judge set (planned **g-3b**, not yet built).
- [x] **2.5h — Source-quality overhaul: sourcing ladder + trustScore** ([#128](https://github.com/mwin02/learning-app/pull/128), blocks 2a–2f). Reworks resource sourcing to fix two flaws in the open-web fallback — unverified/heterogeneous quality, and remediation re-running the same vague query every pass. Restricts sourcing to a curated allowlist via a **preference ladder** (allowlisted sources first; open-web relaxation only on exhaustion — protects coverage on thin concepts) and makes `trustScore` real. **2a** `computeTrustScore` seam ([src/lib/curation/trust-score.ts](../src/lib/curation/trust-score.ts)) — a source-reputation prior moved by precision-weighted evidence signals (degrades to the prior with no signals; extends to user up/down votes later as another term). **2b** YouTube engagement signal (view-weighted, calibrated on live data — like-ratio swings 7× across equally-good channels) + persisted view/like stats + channel IDs (fixes the hostname collision where every `youtube.com` URL matched one seeded channel). **2c** YouTube Data API prong (`search.list` + `videos.list`) with channel-level Source resolution. **2d** the ladder in `web-fallback.ts` (rung 1 = YouTube prong + site-scoped grounded prong, interleaved; rung 2 = open-web prompt; deny-list carries across rungs so a retry is a _different_ search, not a repeat). **2e** `trustScore` into selection ranking (coverage stays the gate, trust orders the qualifiers). **2f** content-reset + cold pre-warm tooling. Validated cold on an emptied library: `python` (14/14), `calculus` (13/13), `linear-algebra`, `javascript-react` (10/11 — on-ramp gap, see 2g) built from **100% curated sources, zero open-web**. Migration `20260627…engagement_signals` (the generated `DROP INDEX` for the hnsw + partial-unique indexes was stripped per AGENTS.md).
  - **Follow-up — generated on-ramp + scope-aware ranking (block 2g, pending; separate branch).** Atomic curation sources the **intro/on-ramp concept** poorly — a 2h "full course" was picked as the python "intro", and the react on-ramp got 0 qualifying candidates (path stuck `building`). Some deep concepts also map to whole-chapter pages (calculus attached 3h Paul's-Notes chapters to single concepts). 2g **generates** the on-ramp's primary lesson (Gemini, **on-ramp only**, `origin='generated'`, fixed first-party trust, rendering deferred to a later block) and adds **scope-aware duration ranking** for _all_ concepts (prefer concept-scoped resources over whole-course/whole-chapter pages).
- [x] **2.5i — Content agent: exercises** (PRs [#138](https://github.com/mwin02/learning-app/pull/138)–[#145](https://github.com/mwin02/learning-app/pull/145), `lib/agents/content/`). **Redesigned from the original "per-Lesson generation during track build under a cost ceiling" into a per-Concept question-bank + build-time sampling architecture** — the expensive authoring happens once per concept and is amortized across every Track built off the Path, so build-time becomes a cheap, no-LLM selection (the per-build cost ceiling dissolved). **1** `ConceptQuestion` model (prompt/answer/rubric/`kind` reusing `ExerciseKind`, `origin` reusing `Origin`; MCQ options embedded in the prompt — reveal-only, no options column) + `Concept.bankReviewed` flag. **2** `authorConceptBank` — a **Gemini-2.5-Pro** pass that authors a small set (`CONCEPT_BANK_TARGET_QUESTIONS=5`) per concept, concept-framed from the title + resource _titles_ (not content — runs at spine-readiness before any Lesson exists; resource-content-grounded authoring is the operator path below). **3** `backfillConceptBanks` fans out per-concept (bounded concurrency, idempotent) wired best-effort into the worker after `spine_ready`; **on-ramp concepts are skipped** (a broad intro shouldn't carry deep practice questions). **4** `exerciseTrack` — post-freeze, non-fatal, idempotent selection that takes a **stratified** sample (`EXERCISE_SAMPLE_PER_LESSON=4`, ≥1 per concept) from each Lesson's bank(s) into frozen `Exercise` snapshots. **5** the discovery API (`/api/playground/concept-banks` + `/questions`, `withAdminAuth`) — the "weak banks, oldest first" worklist (with resource URLs for one-place authoring), add/remove questions, mark-reviewed — the seam for operators/agents to upgrade the generated baseline with resource-grounded questions. **6** both composers' `resourceSufficiency` rule hardened: assessment scarcity is never a thicken trigger (the bank backstops practice; only missing `teaches` counts). **UI:** a collapsible per-concept bank viewer in the concept-map inspector, and the **reveal-only PRACTICE block** in the learn lesson view (fills the slot `LessonView` had scaffolded). Exit criterion (e) (≥1 agent-generated exercise per Track) met end-to-end.
- [x] **2.5j — Delivery-mode classifier** (PRs [#151](https://github.com/mwin02/learning-app/pull/151)–[#152](https://github.com/mwin02/learning-app/pull/152), `lib/curation/embeddability.ts`). Replaces the hardcoded `LessonResource.deliveryMode = newtab` with a real per-resource classification, cached on `Resource` (`embeddable` + `embedCheckedAt`) and amortized across every Track. **1** `classifyEmbeddability` — a **YouTube allowlist** short-circuit (its `/watch` page sends `SAMEORIGIN`, but `ResourcePane` rewrites to the framable `/embed/` form) then a **HEAD header probe** for a blocking frame policy (`X-Frame-Options` deny/sameorigin, or a CSP `frame-ancestors` that isn't a bare `*`); an inconclusive probe (network error) leaves both columns null so a later run retries. Wired into the insert path post-commit (over the same pickable set as embed-on-insert) and read by `build-track` to set `deliveryMode` (embed vs. the safe newtab default; null → newtab). HEAD-only (headers, never body) keeps the response-size DoS surface off the new code; marked the **audit-6.2 SSRF** call site and shaped like `validators/liveness.ts` so the shared outbound-fetch guard drops in later. **2** `backfillEmbeddability` + `scripts/classify-embeddability.ts` — idempotent one-shot over the existing library (atomic, non-generated, `embedCheckedAt IS NULL`), bounded HEAD concurrency. Run cold: **485/485 probed → 199 embed, 286 newtab** (285 of them Khan Academy, which blocks framing), 0 inconclusive. Migration `…phase_2_5j_resource_embeddability` (the generated `DROP INDEX` for the hnsw + partial-unique indexes was stripped per AGENTS.md).
- [ ] **2.5k — Content agent: notebooks.** Agent emits `.ipynb` JSON via Gemini → storage → `Resource(type='interactive', origin='agent', status='pending_review')` → linked via `LessonResource`. Storage backend (Supabase Storage vs GCS) decided at block start.
- [ ] **2.5l — Playground: map + Track.** Render the concept map (spine/frontier, prereq edges, per-concept candidates) and a built Track (ordered Lessons, primary + alternates, delivery mode, inline exercises, notebook links). Track-build progress UI; inspector extended.

**Exit criteria:** a launch topic has a seeded spine map; requesting it builds a Track that (a) topo-respects the prereq DAG, (b) prunes concepts the learner declared known (including spine, conservatively) under an inferred `intent`, (c) fits the time budget — trimming frontier breadth _and_ sizing per-lesson depth by time-weight, (d) surfaces a ranked mandatory core (one or more primaries) plus a frozen optional/alternate pool on a Lesson, (e) has ≥1 agent-generated exercise; and rejecting a resource drops it from the Path's candidate pool (excluded from the next build) and recomputes readiness — in-flight Tracks are immutable snapshots, surfaced for manual triage at `/playground/broken-tracks` rather than auto-patched.

### Deferred decisions (decide when the block is worked)

- **Track cardinality flavor** — per-enrollment snapshot vs. per-version. FK topology is fixed either way; pick when the Track builder's reuse/cost profile is known.
- **Path traversal at the topic edge** — does a Path **bound** the traversal (unmet external prereqs are "assumed" / handled by a Program) or **seed** it? ✅ **Pinned 2026-06-30 as "seed, deferred"** during the Phase 2.75 re-scope: v1 Programs build child Tracks in parallel with presentation-only ordering (each standalone); seeding later phases via threaded `priorKnowledge` is the documented follow-on. See [Phase 2.75 open items](#open-items-for-phase-275).
- **"Course ready" notification** — emailing the requester when a `building` Path reaches `spine_ready` is **deferred to Phase 3**: it needs `User.email` (Supabase auth) + an email provider. The 2.5f worker is built auth-agnostic (records readiness/escalation); the email wire is a thin Phase-3 add.
- **Entity renaming** — Path→`Curriculum`/etc., Track→`Path`. Before a public UI exists, not during the playground phase.
- **Concept granularity policy** — how coarse/fine a `Concept` node is. Decide empirically during 2.5d once real spines exist.

### Open items for Phase 2.5

- **Segment refs for non-YouTube resources.** YouTube timestamps are clean. Doc anchors require fetching + parsing HTML headings. May need a fallback "describe the segment in prose" when no addressable anchor exists.
- **How "alternate" surfaces in UI.** Tabs? Stacked cards? "Try a different explanation" button? Decide during 2.5l; shapes the data model only lightly.
- **Exercise grading.** Reveal-only in 2.5, or wait for the Phase 4 tutor to grade? Lean reveal-only here.
- **Idempotency of track regen.** A failed/superseded Track must never corrupt the Path map. `Track.status='failed'` with diagnostic; a fresh build replaces rather than mutates (immutability holds).
- **"User knows X" → concept matching.** Pruning known concepts maps free-text `priorKnowledge` onto a Path's concept set — fuzzy. _Shipped in 2.5e-5/-6:_ the composer prunes from `priorKnowledge` + `goal` in its judgment pass (incl. spine, conservatively); no embedding match — the LLM does the mapping. Pruning **accuracy** still needs validation on real learner inputs; revisit if conservative-pruning leaves too much redundant or wrongly drops a needed concept.
- **Decomposition failure during discovery.** Transient YouTube API / scrape failures shouldn't nuke the discovery. Commit parent with `decompositionStatus='pending'`, retry via `scripts/retry-decomposition.ts` or on next touch. Parent stays unpickable until decomposed.
- **Discovery latency.** First user to trigger an off-library topic that finds a container pays the decomposition cost (~30s for a 30-video playlist). Accepted for now; revisit in 2.6 if it becomes a UX problem.
- **Headless-render agent decomposer (post-Phase-3).** Replaces the `decompose_manual` human bandaid for SPA courses (Khan Academy, etc.): an agent renders the client-side page, extracts the ordered lessons, and POSTs `decompose_manual` itself. Needs a rendering surface (connected Chrome, or a Cloud Run service with Playwright) — hence deferred until after the Cloud Run migration, to keep a browser dependency off Vercel.
- **Non-embeddable circumvention (revisit).** Options to weigh later: server-side proxy + rewrite (legal risk), agent-generated summaries (quality risk), reader-mode extraction.
- **Critic-triggered re-retrieval (carried from AR).** If the critic finds a gap needing a _different_ resource (not just reordering), v1 re-selects over the existing set only; looping back into retrieval is a future option.
- ✅ **Fallback floor never fills (audit 5.1) — closed.** `ensureFloor` counted only `status='active'` rows while discovery inserts `pending_review`, so a full discovery loop re-fired on every request for an agent-grown topic. Closed by the **`pending_review → active` promotion pipeline** (see the Status design records) plus the topic redesign's related-set widening. Independent of the stampede/queue work (audit 5.2, deferred to Phase 3.1).
- **Pre-decompose dedup (audit 6.1) — cost; compounds 5.1.** Dedup is currently post-decompose: the existing-URL skip lives in `upsertResource` (last step), so re-discovering an already-stored playlist still runs liveness fetches + rules-agent Flash + full YouTube Data API decomposition + concept-derivation before discarding it at upsert. With 5.1 (re-fire every request), a popular cold topic re-pays YouTube quota + decompose cost on every request. Fix: skip URLs already in the library _before_ validate/decompose.
- **Batch post-commit embeds (audit 7.1) — efficiency.** The discovery/upsert path embeds one row at a time (a 50-child playlist = 50 sequential Vertex embedding calls) even though `embedMany` batches natively (the backfill path already uses 100/call). Collect `embedTasks`, embed in chunks of 100, then UPDATE. Also covers the "parallelize post-commit embeds" half of audit 5.4.

## Phase 2.6 — Frontend (was 2f/2g)

Public-facing surfaces. Deferred until after 2.5 because rendering Path-as-flat-list would be throwaway once the Lesson layer exists.

> **Build-order note (2026-06-24).** The Track-view surface (old **2.6b**) shipped first, as the **course player** at `/learn/[trackId]` — the read-only delivery UI is the more load-bearing half and unblocks dogfooding built Tracks. The **landing page (2.6a)** is still pending. Two route/contract divergences from the original 2.6b sketch: the route is **`/learn/[trackId]`**, not `/path/[id]`; and there is **no public `GET /api/paths/[id]` JSON endpoint** — a server-side React-`cache()`'d `getTrackView` loader (`src/lib/track-view.ts`), shared by the layout + both pages and deduped to one query per request, replaced it. The design-token system + dark mode (2.6-5 / lesson-1 below) were **beyond the original plan** — centralized styling infra that the whole learn UI (and future surfaces) now build on; see the [Styling section in CLAUDE.md](../CLAUDE.md).

### ✅ SHIPPED — Course player (`/learn/[trackId]`)

The read-only Track delivery UI: a two-pane shell (sticky `TopNav` + `CourseSidebar` over a content column), a course-home/summary page, and a per-lesson content page with the resource renderer. Progress is **anonymous** (localStorage) behind a `ProgressStore` interface (`src/lib/progress-store.ts`) with a documented single-branch-point swap to the `Progress` table on Phase-3 auth. Built as a stacked PR chain (#104–#111), merged bottom-up.

- [x] **2.6-1 ([#104](https://github.com/mwin02/learning-app/pull/104))** — course-player shell + `Track` read projection. `getTrackView` (`cache()`'d typed contract over the Track/Lesson/LessonResource/Section/Concept select), the two-pane `/learn/[trackId]/layout.tsx`, a server-rendered syllabus sidebar, the course-overview landing pane, and `formatDuration`.
- [x] **2.6-2 ([#105](https://github.com/mwin02/learning-app/pull/105))** — course-home design foundation. `src/lib/course-home-model.ts` — a **pure** view-model deriving section/lesson statuses (`done`/`current`/`todo` — no gating, so no "locked"), per-section fractions + progress, the "continue" lesson, time-remaining, key-concepts, and per-lesson type icon kind from the Track projection + the completed-lesson set. Plus the shared SVG icon set and presentational primitives (progress bar/ring, status pills, lesson icons).
- [x] **2.6-3 ([#106](https://github.com/mwin02/learning-app/pull/106))** — course-home chrome + progress seam. Replaced the Block-1 syllabus with the prototype chrome: sticky `TopNav`, sticky collapsible `CourseSidebar`, and the client `CourseProvider` (`course-context.tsx`) holding the localStorage-backed completed set + the derived model, shared by sidebar and main column. `progress-store.ts` is the persistence seam (localStorage today; `DbProgressStore` + `migrateLocalToDb` stubs document the Phase-3 swap). Hydration-safe (starts empty server + first client render, hydrates after mount).
- [x] **2.6-4 ([#107](https://github.com/mwin02/learning-app/pull/107))** — course-home main column. Hero (eyebrow/title/summary/breadcrumb), `ContinueLearningCard` (resume the current lesson, or a "course complete" state), `StatCards` (overall progress ring, lessons completed, time remaining — the design's "time spent" card swapped for our data), `KeyConcepts` chips (we have no outcomes field → distinct `conceptsTaught`), and the per-section `CourseContentBreakdown`.
- [x] **2.6-5 ([#108](https://github.com/mwin02/learning-app/pull/108))** — **centralized design tokens** (beyond plan). Moved the palette / type scale / radii / layout constants out of per-component arbitrary values into `globals.css` `@theme` tokens (`text-*`/`bg-*`/`border-*`/`rounded-*` utilities) + semantic component classes (`.eyebrow`/`.card`/`.meta`/`.stat-value`); swapped Geist → **IBM Plex** app-wide via the root layout. Codified the rules in a new **Styling** section in CLAUDE.md.
- [x] **2.6-lesson-1 ([#109](https://github.com/mwin02/learning-app/pull/109))** — **OS-preference dark mode** (beyond plan). A single `@media (prefers-color-scheme: dark)` block redefines the `--color-*` tokens (+ `--shadow-card`/`--gradient-thumb`), so every token utility flips with **no `dark:` variants in components**. Added per-resource-type accent tokens.
- [x] **2.6-lesson-2 ([#110](https://github.com/mwin02/learning-app/pull/110))** — lesson route + content scaffold. `/learn/[trackId]/[lessonId]` derives a serializable `LessonViewModel` (eyebrow context, type badge, summary, concepts, prev/next) and renders `LessonView` — title + type badge, summary, "in this lesson" concepts, up-next preview, and footer nav (previous / **mark-complete** / next) wired to the course context. Sidebar gains active-lesson state (rail + tint + `aria-current`, derived-open sections).
- [x] **2.6-lesson-3 ([#111](https://github.com/mwin02/learning-app/pull/111))** — resource renderer + page titles. `ResourcePane` renders the lesson's ranked resources: `deliveryMode='embed'` → a framed `<iframe>` with a **persistent "open in new tab"** escape hatch (cross-origin embeds fail silently) + YouTube `watch`/`youtu.be`/`shorts` → `youtube-nocookie /embed/` rewrite honoring a `segmentRef` start offset; otherwise a prominent new-tab card; alternates listed compactly below. Per-lesson/-course `generateMetadata` tab titles (free off the `cache()`'d loader).

**Known gap (deferred to Phase 3):** `/learn/[trackId]` does **not** gate on `track.status` or auth — `getTrackView` renders any Track by id, including unpublished/draft, with no middleware. Intentional for the playground/dogfooding phase; the publish/visibility gate lands with Supabase auth in Phase 3.

- [ ] **2.6a — Landing page `app/page.tsx`.** Dual-audience hero, form (7-topic dropdown, prior knowledge, timeframe), submit → enqueue a `CourseRequest` (the 2.5g async route returns `202 { requestId }`) → poll → redirect to the built Track at `/learn/[trackId]`. _(Still pending.)_

**Exit criteria:** stranger from the landing page generates a path, lands on the course player, sees the structured Track (not a flat link list), and can iframe-or-open Lessons. _(Met for the player half: built Tracks render as a structured course with embed/new-tab resources + anonymous mark-complete. Pending: the landing-page entry point, and revealing inline exercises — blocked on 2.5i.)_

## Phase 2.75 — Multi-topic Programs (the differentiator)

A `Program` is a goal-driven plan composed of multiple single-topic Tracks — e.g. "be ready for NUS Sem 1 CS AI by Aug 2026 given my background." This is the headline differentiator vs. course aggregators: most sites sell _a course_; we sell _a plan that gets you to your goal_.

> **Re-scoped 2026-06-30 against the shipped 2.5 architecture.** The original plan (above this rewrite in git history) assumed a synchronous "call the 2b curriculum agent once per topic." That agent was **retired in the 2.5g cutover** (−1045 LOC); Path-building is now **async, queue-driven, single-worker** (`POST /api/generate-path` → `enqueueCourseRequest` → `course-worker` → `ensurePathMap` → `remediatePath` → `buildTrack`), deliberately moved off the request path to dodge the Vercel function timeout. The Program layer therefore **rides the same `CourseRequest` queue** rather than reintroducing inline multi-build. Three facts drove the rewrite: (1) no 2b agent to call; (2) a `Path` is **shared per-topic** (`@@unique([topic])`) — the per-learner, budget-allocated artifact is the **`Track`**, so a Program is N _Tracks_, not N _Paths_; (3) `ConceptPrereq` edges live _within_ one Path and the child Paths don't exist at decomposition time, so cross-topic ordering is **LLM-inferred at plan time**, not computed from `conceptsTaught`/`prerequisiteConcepts` overlap.

### Shape

- `Program` owns N **Tracks** (one per topic) via `ProgramPath`, a join entity that adds **phase grouping** (e.g. "Month 1: math + PyTorch"), **cross-program order**, and **priority tier** (`core` / `nice_to_have`). `ProgramPath` references **`trackId`** (the per-learner budgeted snapshot); the Path is reachable via `Track.pathId`.
- `Program` inputs: a free-text **goal**, **background** (the program-level analog of a Track's `priorKnowledge`), **total hours/week**, **deadline or total weeks**. Optionally an **anti-list** ("don't include LeetCode now").
- `Program` carries a **status lifecycle** (`planning → building → ready / partial / failed`) because child builds are async — mirrors `CourseRequest`. `partial` = some child Tracks built, some failed.
- The Program mirrors the per-topic flow: a cheap **synchronous plan pass**, then per-topic builds **fan out onto the existing `CourseRequest` queue** (each child request carries `programId`), then an **assembler hook** in the worker finalizes the Program when all sibling requests reach a terminal state. The per-topic build path is **unchanged**.
- The **program agent** (plan pass only — no building) does three things the per-topic pipeline doesn't:
  1. **Topic decomposition** — goal + background + anti-list → topic list with per-topic gap assessment. The anti-list is a **decomposition prompt constraint** (excluded topics never enter the list), not a resource filter. Each proposed topic must pass the existing `validateTopic` gate (canonical slug + domain check) before it becomes a `CourseRequest` — decomposition can surface an out-of-domain topic, and the gate is where that's caught.
  2. **Budget allocation** — the LLM emits per-topic gap/importance **weights**; code distributes the total hours **deterministically** (with a per-topic floor so no topic rounds to zero). Auditable budgets, matches the track-builder's deterministic-allocator philosophy; re-running with a tighter budget visibly shifts the splits. Each topic's allocated hours/weeks become its child request's `hoursPerWeek` / `timeframeWeeks`.
  3. **Cross-topic sequencing + phase grouping** — **LLM-inferred** topic order + phase grouping from goal + background + topic list. **v1 is presentation-only**: child Tracks build in **parallel** and each is standalone (may re-teach some overlap); the order drives display, not the build. (See the pinned topic-edge decision below.)

### Block sequence (each <300 LOC, one PR per block)

Buildable now with **no auth and no UI** — Programs are headless-inspectable via the DB + a worker `logBuiltProgram` summary (the analog of the per-topic `logBuiltTrack`), exactly as the per-topic flow runs headlessly today. The two frontend blocks are deferred to the post-Phase-3 frontend push.

- [x] **2.75a — Schema.** `Program(id, goal, background, totalHoursPerWeek, totalWeeks, antiList String[], status ProgramStatus, createdBy?, …)`, `ProgramPath(programId, trackId, phaseLabel, orderInProgram, priorityTier)`, `CourseRequest.programId?`, `ProgramStatus` enum. Migration only; no agent yet. **Strip the generated `DROP INDEX` lines per AGENTS.md** (hnsw + partial-unique indexes).
- [x] **2.75b — `lib/agents/program/plan.ts` (plan pass only).** goal + background + budget + anti-list → gated topics + per-topic weight/gap + deterministic budget split + phase/order/priorityTier. Pure and fixture-testable; no building, no DB writes. The real intelligence of the phase.
- [x] **2.75c — Fan-out + assembler.** `enqueueProgram` (create `Program(planning)` + N child `CourseRequest`s with `programId`, budget threaded), and the **course-worker post-fulfill hook**: when a fulfilled/failed request has a `programId` and all siblings are terminal, `assembleProgram` writes `ProgramPath` rows (`trackId`, phase, order, tier) and sets `Program` → `ready`/`partial`. Single-worker concurrency makes the "all siblings terminal" check race-free.
- [x] **2.75d — `POST /api/generate-program` route.** Thin: `withAuth` → Zod validate (goal, background, totalHoursPerWeek, totalWeeks, antiList) → program-agent plan → `enqueueProgram` → `202 { programId }`. Mirrors the fire-and-forget `generate-path` route.
- [x] **2.75e — Frontend (deferred to post-Phase-3).** `app/program/[id]/page.tsx` phased view (each phase a section, each child Track its sequenced lessons with rationale; "if you only do three things" callout surfaces `priorityTier='core'` across all child Tracks) **+** the landing-page "Generate a Program" entry point (goal-driven form). Deferred alongside 2.6a per the build-order decision (UI assumes a logged-in user; lands after Phase 3 auth).
- [x] **2.75f — Agentic decomposer + frontier requests (2026-07-06, PRs #201–#204).** Stage 1 of `planProgram` is now a **tool-using agent** (`program/decompose-agent.ts`, mirroring the composer-agent idiom: `get_path_map` / `propose_course(..., frontierConcepts[])` / `finalize` + finalize-miss fallback) that inspects existing concept maps and records per-topic **frontier-concept requests as data**; the worker executes them (`addFrontierConcept`, capped by `MAX_FRONTIER_PER_TOPIC`) between `backfillBanks` and `buildTrack`, best-effort/non-fatal. Requests ride `CourseRequest.frontierConcepts String[]` (so the hook also serves future standalone requests) and survive gate/reconcile/budget with a union-on-canonical-collapse merge. The one-shot `decomposeProgram` stays as the injectable rollback. Live driver: `scripts/verify-decompose-agent.ts`.

**Exit criteria** (met headlessly via API + worker, no UI): input like "Ready for NUS Sem 1 CS AI by Aug 2026, my background is full-stack TS with rusty math" produces a multi-topic Program whose child Tracks are budget-allocated, gated, phase-grouped, and priority-tiered, assembled by the worker into a `ready` Program. Re-running the same goal with a tighter budget visibly drops `nice_to_have` items / shifts the deterministic splits.

### Open items for Phase 2.75

- ✅ **Budget allocator design — decided (2026-06-30).** LLM topic-weights + **deterministic** distribution (auditable, reproducible), not pure-LLM allocation.
- ✅ **Anti-list semantics — decided (2026-06-30).** A **decomposition prompt constraint** (topic-level exclusion), not a resource filter.
- ✅ **Topic-edge "bound vs. seed" (carried from the 2.5 deferred decisions) — pinned (2026-06-30) as "seed, deferred."** v1 builds child Tracks in parallel with presentation-only ordering (each Track standalone). The richer "seed" mechanism — threading earlier-phase covered concepts into later child requests' `priorKnowledge` so the composer prunes cross-topic redundancy — is the documented follow-on; it requires serializing the build by phase and tracking inter-phase coverage.
- ✅ **Decomposition granularity / topic reuse — decided (2026-07-01).** The 2.75b decomposer was fragmenting coarse topics into cold sub-topics (e.g. splitting `calculus` into brand-new `differentiation` + `integration` Paths) because it was blind to the library. Fixed by **grounding the decomposition prompt on the existing topic list** (curated `TOPIC_SLUGS` + `listCanonicals()`) plus a hard "prefer these; never split a topic into sub-parts — a narrower need is a _scope_ of the topic, stated in its rationale" rule, mirroring the topic gate's own tier-3 grounding. **v1 does whole-topic reuse only** (`calculus` is reused; the sub-focus lives in the rationale → child Track `goal`). Inherits the gate's unbounded-`listCanonicals`-dump scaling caveat (audit 2.1) — the grounding list should move to bounded nearby-candidate retrieval as the registry grows; **richer, efficient decomposer context (per-topic concepts, embedding retrieval) is a deferred follow-on.**
- **True intra-topic subsetting (post-2.75).** v1 reuses a whole topic and lets the per-topic budget scale its depth; it **cannot** yet produce a Track that teaches a strict _subset_ of a topic's spine (e.g. `calculus` limited to just differentiation + integration), because the Track composer treats the spine as the **required floor** — it prunes _known_ concepts (`priorKnowledge`) and trims optional frontier, but never drops spine nodes by goal. Goal-driven spine-subsetting is a real new composer capability worth exploring **after Phase 2.75** (its own block of work); until then, whole-topic reuse is the intended behavior.
- **Goal modeling depth.** Free-text goal + LLM-parsed topics is the simplest start. May need a structured goal schema if results are too fuzzy.
- **Cross-topic dependency confidence.** Presentation ordering is LLM-inferred in v1. A later refinement could reorder phases from real `Concept`-overlap across the built child Paths (a _post-build_ pass — the concepts don't exist at decomposition time), but overlap may be sparse for web-fallback topics until canonicalization matures.
- **Where do "practice milestones" live?** Items like "implement A\* on 8-puzzle" aren't existing Resources. May lean on Phase 2.5's `Exercise` to represent these as auto-generated milestones inside a Program.

## Phase 3 — Auth + Stripe (intentionally before tutor)

### Shipped — auth + access control (3a–3f, PRs [#183](https://github.com/mwin02/learning-app/pull/183)–[#188](https://github.com/mwin02/learning-app/pull/188), 2026-07)

- [x] **3a — User schema.** `User.id` doubles as the Supabase auth user id; `role` column feeds the admin gate.
- [x] **3b — Supabase Google OAuth via `@supabase/ssr`.** `withAuth` verifies real JWT sessions from cookies (`getClaims`); the `DEV_AUTH` bypass survives only in `NODE_ENV=development` (dead in production builds by construction). `withAdminAuth` became a distinct `User.role === 'admin'` DB check returning a non-enumerable 404 — **audit 9.1 (HIGH) closed**.
- [x] **3c — Limits + enrollment.** `programQuota` ([src/lib/services/program-limits.ts](../src/lib/services/program-limits.ts)) meters Program creation per user per UTC calendar month (`FREE_PROGRAMS_PER_MONTH`; failed plans don't burn quota) — deliberately the ONE file Stripe tiers will touch. `POST /api/generate-path` demoted to admin/operator-only; **`POST /api/generate-program` is the single public creation route**.
- [x] **3d — Route protection.** `getViewer` / `requireAdminPage` ([src/lib/auth/viewer.ts](../src/lib/auth/viewer.ts)) gate pages (server components) with the same primitives as the API wrappers; playground pages 404 for non-admins.
- [x] **3e — Account UI + `/programs/new` form.** The structured stand-in for the chat intake agent — the agent will construct the SAME payload and hit the same endpoint.
- [x] **3f — DB-backed progress.** Signed-in learner progress persists per user (replacing anonymous-only local progress).

Also closed by earlier work: **async generation (audit 1.2/1.3)** — the 2.5g cutover moved all Track building onto the durable `CourseRequest` queue + worker; `generate-program` runs only the bounded plan pass inline and returns `202 { programId }`. (The worker-side per-call `abortSignal`/timeout + overall job deadline from 1.3 remains open — block **H4** below.)

### Remaining — Stripe

- [ ] `app/pricing/page.tsx` — single tier, placeholder price
- [ ] `app/api/stripe/checkout/route.ts`, `app/api/stripe/webhook/route.ts` — webhook flips `User.plan = 'paid'`
- [ ] Free→paid gate enforced (free = 1 program + preview; paid = full access + tutor) — flips inside `program-limits.ts`
- [ ] Stripe **test mode** in dev

### Remaining — creation-route hardening (audit Sections 1 + 9) — ⭐ NEXT UP, gates the chat intake agent

What's left of the audit's security-critical set now that auth landed. Scoped as four <300-LOC blocks, one PR each:

- [ ] **H1 — Burst rate limit + idempotency on `generate-program` (audit 1.1 remainder).** The monthly quota is the only throttle: a double-clicked submit creates two Programs (burning quota), and a scripted loop can burn a month's quota in seconds or hammer the plan pass (an LLM call) via requests that fail *after* it. Add (a) a short-window per-user creation cap — count Program rows (all statuses, including `failed`, which IS persisted) created in the last hour, reject over `PROGRAM_BURST_PER_HOUR` with 429 — and (b) idempotent submit — dedup on a payload hash (user + goal + params) within a short window, returning the existing `programId` as a 202 instead of creating a sibling. Both live in `program-limits.ts` beside `programQuota`.
- [ ] **H2 — Origin check + health-probe gate (audits 9.7 + 9.2).** (a) CSRF: state-changing methods through `withAuth`/`withAdminAuth` require an `Origin` header matching the app's own origin (403 otherwise) — one check in the wrappers covers every current and future mutating route, incl. the chat endpoint. (b) `GET /api/health?probe=ai` fires an unmetered live model call per anonymous hit and echoes raw `err.message`; gate the probe behind admin (plain liveness stays public) and stop leaking the error. _(9.2 pulled forward from Phase 3.1 — it's two lines once the wrappers exist.)_
- [ ] **H3 — Per-generation cost observability (audit 9.4).** Replace `console.log`-only with a structured (JSON) log helper carrying a request/trace id through the plan pass and worker pipeline, and persist per-job token usage on the anchor records (`Program` for the plan pass, `CourseRequest` for builds) so runaway cost is visible before the bill, not after. The chat intake agent multiplies LLM calls per program — this lands first. (Critique-verdict persistence, audit 8.4, stays in Phase 3.1.)
- [ ] **H4 — Worker job deadline + abortSignal (audit 1.3 remainder).** `reclaimStale` bounces a stale _row_ back to `queued`, but the single-concurrency worker loop still `await`s the hung pipeline promise — one wedged upstream call (LLM, fetch) stalls the ENTIRE queue, and with public creation live that's every user's build. Add (a) an overall per-job deadline: `tickOnce` races the pipeline against `COURSE_JOB_DEADLINE_MS`, failing the request with a diagnostic and moving on; (b) an `AbortSignal` threaded from that deadline through the pipeline stages into their LLM/fetch calls (the AI SDK accepts `abortSignal`), so the abandoned work actually stops instead of burning tokens in the background. The race is the backstop even where a call site doesn't yet forward the signal.

**Then: the chat intake agent** (own feature, own conversation) — the home-page chat that gathers goal/background/budget and POSTs the same validated `/api/generate-program` payload as the 3e form, riding every gate above. Non-negotiables set here: the agent gets NO privileged server path (it submits through the public route, so quota/burst/validation apply); every chat turn is an LLM call, so it ships with its own per-user message rate limit + per-conversation turn budget; user text is delimited as untrusted data in its prompts (the decompose agent already models this).

**Exit criteria:** unauthenticated → Google sign-in → create a program (202 + programId; worker builds; visible in the notebook UI) → pricing → checkout (test card) → webhook unlocks paid features.

## Phase 3.1 — Launch readiness (curriculum-agent audit)

Findings from the curriculum-agent code audit that aren't security-critical (those live in Phase 3) but should be addressed before real traffic. Grouped by audited section.

> **Full audit:** [docs/curriculum-agent-audit.md](curriculum-agent-audit.md) — all findings (Sections 1–4 so far) with severity, disposition, and what's working well. The items below are the Phase-3.1-dispositioned subset.

### Topic gate + registry (audit Section 2)

- [ ] **Bounded canonical retrieval (audit 2.1).** `listCanonicals()` loads _every_ canonical ever minted and concatenates all of them into the tier-3 grounding prompt. The list grows without bound across the broad launch niche, raising per-call token cost and _degrading_ classification (more near-duplicate mints) exactly as the table grows. Replace the dump-everything approach with nearby-candidate retrieval (embedding/prefix match) once the registry is non-trivial.
- [ ] **Canonical correction/merge tool (audit 2.3).** First-writer-wins makes a bad canonicalization permanent with no fix path; two phrasings of one concept can mint distinct canonicals and fragment the library. Add a small admin merge/relabel utility, and seed the curated `TOPIC_SLUGS` as self-aliases so the model maps onto them deterministically instead of re-deciding each run.
- [ ] **Unicode-harden `normalizeTopic` (audit 2.4).** Add NFKC normalization + zero-width-char stripping so homoglyph phrasings (`pythοn` with a Greek omicron) don't bypass the alias cache into a model call + a distinct canonical.
- [ ] **Type `TopicAlias.subject` (audit 2.5, nit).** It's a free `String` cast with `as TopicSubject`. An enum or check constraint makes it self-enforcing.
- [ ] **`TOPIC_RELATIONS` maintenance — proactive detection + table migration.** `TOPIC_RELATIONS` is a hand-curated code constant, but the gate mints topics autonomously, so a foundational/specialization overlap (the `javascript` vs `javascript-react` case the [topic-partition redesign](#-shipped--topic-partition-vs-semantic-search) fixed) can silently recur — a _missing_ relation re-introduces the mis-filing bug, while a _wrong_ relation only causes bounded search bleed, so optimize detection for recall and application for precision (human-gated). Foundation already shipped: **`scripts/audit-topic-relations.ts`** (reactive — ranks unrelated pairs by concept-overlap; run periodically, ideally as a scheduled "librarian" routine, NOT Vercel Cron). Remaining work: (a) **mint-time hook** in the topic gate — when a new canonical is minted, _propose_ a relation against existing same-subject topics (catches conflicts at creation, not after drift); (b) **promote `TOPIC_RELATIONS` to a `TopicRelation` table + admin approval surface** once per-relation PRs become friction (the "promote when auto-populated" trigger from the redesign's design record); (c) **richer audit signals** — a persisted cross-topic URL-collision counter and per-row cross-topic nearest-neighbour density (more discriminative than the centroid cosine, which a technical corpus clusters too tightly to threshold on). Pairs with [canonical correction/merge (audit 2.3)](#topic-gate--registry-audit-section-2) — both are topic-registry hygiene.

### Web fallback (audit Section 5)

> 5.1 (floor never fills) moved to **Phase 2.5 open items** — it's a small, path-generation-relevant metric fix.

- [ ] **Web-fallback stampede / global queue (audit 5.2).** No lock/dedup means concurrent first-requests for one cold topic each run a full Gemini 2.5 Pro loop. Build a global web-fallback queue with: a worker pool processing ≤ N at a time (global Vertex-Pro/DSQ protection), in-flight dedup (don't process a topic already queued/running), and a threshold re-check at dequeue (skip if the library filled while queued). Deferred here because by Phase 3.1 we're likely on **Cloud Run** — a long-lived process makes a simple in-process worker-pool queue viable (an in-process queue doesn't span Vercel serverless instances, which is what made this awkward earlier). If still on Vercel when picked up, fall back to a Postgres advisory lock per topic + recheck (gives dedup + recheck but not the global N-cap).
- [ ] **Double-fallback + fan-out (audit 5.3–5.5).** Deduplicate the deterministic floor vs. the model's discretionary fallback within one request; bound decompose concurrency and parallelize post-commit embeds; abort discovery after N consecutive empty results.

### Decomposition (audit Section 6)

> 6.1 (pre-decompose dedup) moved to **Phase 2.5 open items** — it's path-generation-relevant and compounds the 5.1 cost fix.

- [ ] **Outbound-fetch hardening (audit 6.2–6.4) — one block.** Across liveness, doc-TOC, and youtube-oembed fetches: (6.2) block non-http(s) schemes + private/link-local IP ranges and re-check on each redirect hop (SSRF defense-in-depth); (6.3) add a fetch timeout to the doc-TOC scraper (it has none today); (6.4) cap the response read by streaming/`Content-Length` instead of buffering the full body before slicing (OOM/DoS).

### Upsert & embeddings (audit Section 7)

> 7.1 (batch post-commit embeds) moved to **Phase 2.5 open items** — path-generation-relevant efficiency fix.

- [ ] **`resolveSource` full-table scan (audit 7.2).** Loads the entire (agent-extensible) `Source` table and host-matches in JS on every insert. Cache with a TTL, or add a normalized `host` column + indexed lookup.

### Select & critic (audit Section 8)

- [ ] **Graceful-drop unknown handles (audit 8.1).** One fabricated handle currently 422s the whole request; drop the offending item instead (hard-error only on zero valid items) — fabrication is still prevented, the path is salvaged.
- [ ] **Renumber path `order` to dense `1..N` (audit 8.2).** Model-emitted duplicate/sparse `order` currently 500s at persist via the `@@unique([pathId, order])` constraint. Renumber after sort to remove the failure class.
- [ ] **Deterministic `budgetFit` (audit 8.3).** Compute the budget pass/fail in code (the arithmetic is already done) instead of asking the LLM; reserve the model for judgment-based criteria.
- [ ] **Persist the critique verdict (audit 8.4).** Store `passedCritique` + failed criteria on `Path` so known-deficient paths are queryable and you can measure agent quality over time.

### Other cross-cutting (audit Section 9)

- [x] ~~**Health-probe auth (audit 9.2).**~~ Pulled forward into [Phase 3 hardening block H2](#phase-3--auth--stripe-intentionally-before-tutor) — trivial once the Origin check touches the wrappers anyway.
- [ ] **Delimit `priorKnowledge` in prompts (audit 9.3).** 500-char free text flows raw into retrieval/select/critic prompts. Delimit as untrusted data and instruct the model to treat it as the learner's description, not instructions.

> **Topic partition vs. semantic search** (the audit's biggest design item) — ✅ **shipped** (Blocks 1/2b/2a/3, PRs #44–#47); see the Status section at the top of this file.

## Phase 4 — Tutor agent (deep feature — spec §6)

- [ ] `lib/agents/tutor-agent.ts` — single agent, modes `tutor | quizzer | path_adjuster`
- [ ] `lib/agents/prompts.ts` — one structured system prompt with mode switching
- [ ] Server-side context assembly per call (current item title + summary, outline done/next, recent perf)
- [ ] `app/api/tutor/route.ts` — `streamText` streamed
- [ ] Tutor panel on `app/path/[id]/page.tsx` (paid gate)

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

**Definition of done (spec §10):**

- [ ] A stranger can sign up, generate a path, pay via Stripe (live), and unlock paid features with zero manual intervention
- [ ] Gemini runs through Vertex AI
- [ ] Path generation is agent-driven, returns sequenced items + rationales
- [ ] Context-aware streamed tutor works on any item
- [ ] At least one checkpoint adapts on pass/fail, visibly
- [ ] Progress indicator reflects completion
- [ ] Free→paid boundary clear and enforced
- [ ] Deployed at a public URL

## Out of scope (post-launch)

Native mobile, certificates, spaced repetition, multi-seat, VARK personalization. Cloud Run migration is a post-launch nice-to-have for credit usage + 2nd-GCP-product story.

## Open items to revisit before Phase 3

- Final monthly price (placeholder until then)
- Whether to add Resend (email) for transactional emails — defer unless Stripe needs it
- Whether to migrate hosting to Cloud Run before or after launch (currently: after)
- **When to move course workers to the cloud.** The worker is containerized (`Dockerfile.worker`) and runs locally as N compose replicas (`docker compose --profile workers up`, workers-B/C); promoting it to always-on Cloud Run **worker pools** draining the production queue is scripted step-by-step in [docs/worker-deploy.md](worker-deploy.md). Trigger: real users waiting on builds the laptop workers can't be trusted with (always-on billing starts then).
