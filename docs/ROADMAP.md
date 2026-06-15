# Roadmap — Adaptive Learning Path (90-Day AI Venture)

This roadmap mirrors the build order from the original spec (`learning-path-mvp-spec.md`, §9) and is the source of truth for what we're working on next. Edit as the project evolves.

## Status (as of 2026-06-05)

**Shipped:** Phases 1, 2, 2.5a (schema), the full **2.5-AR curriculum-agent redesign**, and the **topic partition vs. semantic search** redesign (Blocks 1/2b/2a/3, PRs #44–#47). The playground generates real sequenced paths end-to-end — library-first retrieval, pgvector search, web fallback, topic canonicalization, and a rubric critic — with a full agent trace.

### ✅ SHIPPED — Topic partition vs. semantic search

`resource.topic` was a single hard partition that conflated _subject matter_ with _the discovery context that found a resource_. Two distinct sub-problems — (a) **mis-filing** (discovery stamped the requesting path's topic onto every find) and (b) **legitimate overlap** (React draws on JS foundations) — resolved across four stacked PRs:

- **Block 1 ([#44](https://github.com/mwin02/learning-app/pull/44))** — `TOPIC_RELATIONS` + `relatedTopics()` ([src/types/resource.ts](../src/types/resource.ts)); `searchResources` and `ensureFloor` widen to `topic ∈ (requested ∪ related)`. Fixes (b) without bleeding unrelated subjects (calculus ⊥ linear-algebra — no edge by design). Also hardened the web-fallback tag canonicalizer against truncated-JSON crashes.
- **Block 2b ([#45](https://github.com/mwin02/learning-app/pull/45))** — wired the previously-dead `PENDING_REVIEW_GATE_PER_TOPIC`: an above-gate topic generates from `active`-only content; a session's own `triggerWebFallback` discoveries bypass the gate via a per-session id allowlist (so ambient `pending_review` stays excluded but deliberate finds don't).
- **Block 2a ([#46](https://github.com/mwin02/learning-app/pull/46))** — discovery topic classifier ([classify-topic.ts](../src/lib/agents/tools/classify-topic.ts)): each find is filed under its home topic, bounded to `requested ∪ related`, fixing (a) at the root. No-op for topics without a relation.
- **Block 3 ([#47](https://github.com/mwin02/learning-app/pull/47))** — one-time backfill ([scripts/reclassify-topics.ts](../scripts/reclassify-topics.ts)) relabeled **247** existing rows (246 `javascript-react → javascript`); `javascript-react` tightened from 285 → ~40 actual-React rows, `javascript` went 0 → ~288.

**Design record:** the embedding is already global (title+summary+concepts), so the lever was _how hard topic gates search_, not concepts-vs-topic. Relatedness lives in a **code constant** (`TOPIC_RELATIONS`), not a table — promote to a table only if/when relations are auto-populated at gate-mint time. The **subject ceiling** is enforced by the relation bound, not the coarse `subject` field (which lumps calculus + linear-algebra under `math`). `WHERE topic IN (…)` is served by the existing composite `@@index([topic, status, tier])` leftmost prefix — no new index needed. (Separately: the `col::text = …` enum-predicate casts still defeat `@@index([difficulty])`; revisit if search filtering becomes a bottleneck.)

### ✅ SHIPPED (on branch) — `pending_review → active` promotion pipeline

The topic redesign wired the gate but surfaced a load-bearing gap (audit 5.1): **nothing promoted `pending_review` → `active`.** The promotion pipeline (`src/lib/curation/pending-review.ts` + `/api/playground/pending-resources`, commit `b14d598`) closes it: `withAdminAuth`-gated approve (→`active`) / reject (→`deprecated`), multi-level subtree cascade via a recursive CTE, race-safe conditional updates. Reject also flips referencing `PathItem active→removed` and records `Resource.deprecationSeverity` (`soft`=quality / `hard`=broken link) — the field the new Phase 2.5 Track layer branches on.

### ⭐ NEXT UP — Phase 2.5 redesign: Topic Concept Map + Track Traversal

`Path` becomes an **input-agnostic concept map for a whole topic**; `Track` becomes a **learner's immutable traversal** of it. See the [Phase 2.5](#phase-25--topic-concept-map--track-traversal) section for the model, locked decisions, data-model changes, and block sequence. First block: **2.5c — additive schema + inert re-keys** (zero risk to the live generate flow).

**Then:** **2.5d–k** (Path builder → Track builder → async thickener → cutover → content/delivery → playground) → 2.6 (frontend) → 2.75 (Programs) → 3 (auth + Stripe) → 4–6.

**Agent code layout:** agents live under `src/lib/agents/` (curriculum pipeline in `agents/curriculum/`, tools in `agents/tools/`, web-discovery validation in `agents/validation/`); shared AI primitives (`vertex`, `models`, `embeddings`) under `src/lib/ai/`. New agents (`decomposition`, `track`, `content`, `program`, `tutor`) land under `agents/`.

## Locked decisions

| Area                   | Choice                                                 | Why                                                                                               |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Niche                  | Tech upskillers + students (math/science)              | Broad free-content pool, dual-audience landing                                                    |
| Launch topics (seeded) | Python for data/ML, JS+React, Calculus, Linear Algebra | All four have massive free-content pools to aggregate                                             |
| AI provider            | Vertex AI (Gemini) from day 1                          | GCP credits available; credits don't apply to plain Gemini API key                                |
| DB + Auth              | Supabase (Postgres + Google OAuth)                     | One provider for DB, auth, RLS; matches "Google sign-in only"                                     |
| Payments               | Stripe Checkout, single subscription, price TBD        | Spec-mandated; revenue is a competition criterion                                                 |
| Styling                | Tailwind CSS                                           | Per spec                                                                                          |
| Hosting                | Vercel now → Cloud Run later                           | Fast start; Cloud Run later adds a 2nd GCP product + uses credits                                 |
| ORM                    | Prisma over Postgres (Supabase-hosted)                 | Per spec                                                                                          |
| Resource library       | Postgres `Resource` table, agent-extensible            | Library compounds with use; the Phase 2 agent writes vetted finds back so quality grows over time |

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
- Every agent resolves model config via the registry (`MODEL_*` env overrides).
- ~~Generation inputs live on `Path` (reproducible artifact). Same input = fresh path; no caching.~~ — **Reversed by the [Phase 2.5 redesign](#phase-25--topic-concept-map--track-traversal).** Per-user inputs (`priorKnowledge`/`timeframeWeeks`/`hoursPerWeek`) move _off_ Path onto the Track; `Path` becomes an input-agnostic per-topic concept map (one per canonical topic, agent-owned, no `createdById`). Freshness now lives at Track-build; the shared map is intentionally reused.
- ~~`Path.createdBy` is a nullable FK.~~ — **Reversed by the Phase 2.5 redesign** (Path is agent-owned, not user-created); retired with `PathItem` at the 2.5g cutover.

**The 2e discovery that reshaped 2.5:** a Path of curated links is the right _generation_ artifact but not the right _delivery_ one — whole-course resources overlap (redundant coverage), and items linking into external sites kill progress tracking and the future tutor's context. So a **Lesson layer** sits above PathItem: structured, lesson-by-lesson delivery built from heterogeneous web resources. That is Phase 2.5.

## Phase 2.5 — Topic Concept Map + Track Traversal

> **Redesigned 2026-06-07.** The original "Structured Track Agent" treated `Track` as a 1:1 dedup wrapper over a _user-specific_ `Path`. A design pass reconceived the two layers around a **template/instance split**: `Path` becomes an **input-agnostic concept map for a whole topic**; `Track` becomes a **learner's immutable traversal** of that map. Resource invalidation, per-learner personalization, and the 2.75 Program layer all fall out more cleanly. The shipped foundations (2.5a schema, 2.5-AR curriculum agent, 2.5b decomposition) are unchanged and still load-bearing; only the _delivery_ layer (old 2.5c–g) and its Track-layer decisions are replaced.

### The model

- **`Path` = a topic's concept map** — input-agnostic, agent-owned, **one per canonical topic** (keyed via the `TopicAlias` registry). Holds Path-scoped `Concept` nodes + a prerequisite **DAG** between them + per-concept **candidate resources**. Each concept carries `spine | frontier` membership: the **spine** is the required backbone, the **frontier** is opt-in enrichment. A living asset the map-builder maintains.
- **`Track` = a learner's immutable traversal** of a Path. Walks the spine sub-DAG, prunes concepts the learner already knows, trims to the time budget, pulls in frontier concepts as budget allows, picks one **primary** resource per Lesson and freezes the runners-up as **alternates**, generates exercises, and **snapshots**. Carries the per-learner inputs + user-facing title/summary.
- **Invalidation policy** (drives `Resource.deprecationSeverity`, already shipped): `soft` (quality downgrade) → excluded from _future_ Track builds only; in-flight Tracks untouched. `hard` (dead link) → also reach into live Tracks: **promote a frozen alternate to primary, else flag** the LessonResource so the learner can skip. Immutability is of the _learning structure_ (lessons, ordering, progress keys), not of every resource pointer.
- **Why Path-scoped, not a global concept graph:** a global graph needs library-wide concept canonicalization (the `TopicAlias` problem one level down, far worse) and shared-mutable edges with no blast-radius containment. Path-scoped nodes trade cross-topic concept reuse for tractability + containment + cheap subgraph snapshotting. Cross-topic prerequisites get an explicit home at the Program layer instead of leaking through traversal.

### Locked decisions — carried forward from original 2.5 (decomposition; unchanged)

| Decision                  | Choice                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Naming                    | `Track` for the structured layer; `Lesson` for the unit. Avoids collision with "course" as a resource type.                        |
| Where decomposition lives | **Resource-discovery time, not build time.** Decomposed once, cached on Resource forever.                                          |
| Container resources       | `course`-typed Resources are **container-only** — never picked. Atomic children link via `parentResourceId` + `orderInParent`.     |
| Decomposition router      | YouTube playlists (Data API) + doc-TOC scrape + "single = atomic"; paid platforms out of scope; unsupported → `human_review`.      |
| Decomposition status      | `Resource.decompositionStatus ∈ {atomic, decomposed, pending, unsupported, human_review}`; atomic + decomposed-children pickable.  |
| Concept re-derivation     | Decomposed children re-derive `conceptsTaught` from their own content, not inherited slices of the parent's.                       |
| Non-embeddable delivery   | Iframe where allowed; **open-in-new-tab + "mark complete"** where blocked. `deliveryMode` lives on `LessonResource`, not `Lesson`. |
| Where exercises live      | `Exercise` attaches to `Lesson`. Notebooks become `Resource(type='interactive', origin='agent')`, linked via `LessonResource`.     |

### Locked decisions — this redesign (supersedes the original Track-layer decisions)

| Decision                           | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path's role                        | **Input-agnostic concept map for a whole topic**, not a per-request user artifact. One Path per canonical topic; agent-owned. Loses `createdById`, `difficulty` (now per-resource), the `input*` snapshot, and its user-facing title.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Concept representation             | **Path-scoped `Concept` nodes** with a stable per-Path slug. Canonicalization is a _within-one-map_ match-or-create on thicken (tractable), never global.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Ordering                           | A **prerequisite DAG** of intra-Path `ConceptPrereq` edges (cycle-validated). The _linearization_ (topo-sort) is a Track-build concern, not stored on Path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Scope bounding                     | **Core spine + opt-in frontier.** Track quality keys on a complete _spine_, not a complete map; the frontier thickens over time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Concept ↔ Resource                 | A `ConceptResource` link carrying a **role** (teaches/uses/assesses) + a **coverage/quality score**, so the builder can pick a primary and rank alternates. Candidates are existing pickable rows (`active` + `atomic`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Track ↔ Path cardinality           | **Drop `Track.pathId @unique`** (1 Path → many Tracks). FK topology is fixed: `EnrolledPath → trackId`, `Progress → lessonId`. The **flavor** (per-enrollment snapshot vs. per-version) is _deferred_ — both satisfy the same FKs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Where progress + enrollment live   | **On the Track/instance side.** `Progress` keys on `lessonId` (the completable unit); `EnrolledPath` references the pinned `trackId`. `Path`/`PathItem` become a pure generation artifact the learner never touches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Alternates' origin                 | **Byproduct of per-concept candidates.** Track picks a primary from a concept's candidates and freezes the rest as `role='alternate'`. No separate alternate-sourcing step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Thin-then-thicken vs. immutability | **The spine builds synchronously and gates the first Track**; only frontier concepts + extra candidate resources (the alternates) thicken async. A Track frozen during the thin window is always _spine-complete_ — just alternate-thin — never broken.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Spine-ready gate                   | **`Path.status = spine_ready` iff every spine concept has a `teaches` candidate at/above the coverage floor (`MAP_SPINE_MIN_PRIMARY_COVERAGE = 0.5`).** A concept with only `uses`/`assesses` candidates — or only weak `teaches` — is a _spine hole_ and the Path stays `building`. The gate is honest about "can we actually teach every backbone concept"; it never green-lights a Track with an unteachable node. (Shipped 2.5d-3.)                                                                                                                                                                                                                                                           |
| Spine-hole remediation             | When a freshly-built Path lands `building` (a thin / novel topic), an async worker fills the holes via **targeted per-concept discovery → re-judge → re-attach**. **Exhaustion policy: relax the bar first** — accept the best available `uses` / below-floor `teaches` so the learner still gets a (weaker) course — **and only if a concept is _still_ uncoverable, park it in the human/agent review queue AND page a developer to get on it immediately.** Folded into the **2.5f thickener** (identical machinery to the hard-deprecation regression re-fill; only the trigger differs). User-facing "your course is ready" email is **deferred** — it needs `User.email` from Phase 3 auth. |
| Map maintenance                    | A **map-builder** agent is a _standing_ job (build spine, then thicken + attach new finds), distinct from the per-request **track-builder**. Both reuse the AR hybrid-control-flow template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PathItem` fate                    | **Retired at cutover.** `Concept`/`ConceptPrereq`/`ConceptResource` replace its role as the curriculum record. `Lesson`/`LessonResource`/`Exercise` (from 2.5a) are kept as-is — the Track's delivery shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Entity renaming                    | **Deferred.** Internally "Path" now means "concept map" and "Track" the user's plan — colloquially the reverse. Whether to rename (e.g. Path→`Curriculum`, Track→`Path`) is decided before there's a public UI to break, not now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Completed

- [x] **2.5a — Schema additions** (migration `20260528…track_lesson_decomposition` + playground inspector). `Resource` gains `parentResourceId` (self-FK), `orderInParent`, `decompositionStatus`. New models `Track`, `Lesson`, `LessonResource` (`role`, `deliveryMode`, `segmentRef?`), `Exercise`. PR #23.

#### Phase 2.5-AR — Curriculum Agent Redesign ✅

The 2b agent was a single `generateText` call that dumped a topic's whole library into the prompt and picked by positional index. 2.5b breaks that (decomposition explodes containers into dozens of atomic children), so AR turned the agent into a multi-step, tool-calling agent.

**Architecture (now the template for the Track / Content / Program / Tutor agents):** an autonomous tool-calling **retrieval loop** (the model decides when to search, broaden, or fall back) hands a fixed candidate set to a **deterministic select → critic → revise** pipeline that emits the customer-facing artifact. Agentic where flexibility pays; auditable where correctness matters.

**Shipped blocks:**

- [x] **AR-1** — pgvector + Vertex embeddings on `Resource` (migration `20260601…resource_embedding`); embed-on-insert in the 1b seed path + 2c discovery upsert; `scripts/embed-resources.ts` backfill. PR #24.
- [x] **AR-2** — `searchResources` hybrid search (structured filters → vector rank, ≤30 load-all fast-path), wrapped as an AI SDK `tool()`; resource-search playground page. PRs #25–#26.
- [x] **AR-3** — Autonomous retrieval loop (`searchResources`, `getResourceDetails`, `triggerWebFallback`) returning a candidate set keyed by opaque session-scoped handles. PR #26.
- [x] **AR-4** — Deterministic select → emit over the retrieved set; preserves the `CurriculumInput`/`CurriculumOutput` contract so `/api/generate-path` + `PathService` are untouched. PR #27.
- [x] **AR-5 (topic registry)** — `TopicAlias` registry + migration `20260602…topic_alias_registry`; topic canonicalization grounded and persisted in the gate. PR #28.
- [x] **AR-6** — Rubric critic (separate `criticAgent`: prerequisite ordering, budget fit, whole-course redundancy, difficulty match, rationale specificity) → structured findings → bounded revise loop (max 2). Plus a **full-pipeline agent trace** surfaced in the playground.

**Patterns now established (reuse for future agents):**

- **Hybrid control flow** — autonomous loop for retrieval; deterministic pipeline for output.
- **Hybrid search, never pure vector** — structured filters (`topic`, `status`, pickability) first, then vector rank within that set; ≤30 candidates → return all.
- **Opaque handles** — tools return short session-scoped IDs; any submitted ID is validated against what was actually returned this session (replaces the positional-index anti-hallucination trick).
- **Separate critic call** against an explicit rubric → bounded revise (not self-grading in the same context).
- **Emit isolated from tools** — combining `tools` + `Output.object` in one call silently drops structured output, so emit is a separate `Output.object` call with no tools over the gathered candidate set.

#### Phase 2.5b — Decomposition pipeline ✅

Container resources (playlists, doc trees, whole courses) are decomposed into atomic, pickable child Resources at discovery/seed time, plus a human/agent curation layer for containers the routers can't (or won't) auto-explode. Code lives under `lib/agents/decomposition/` (router → `decompose()` orchestrator → per-source routers → shared `upsertResource`/`decomposeExisting` sink), not the single `decomposition-agent.ts` originally sketched.

**Shipped blocks:**

- [x] **2.5b-1** — Decomposition seam + `atomic` fast-path; `decompose()` returns a plan the caller persists, so discovery and the seed share one write path. PR #32.
- [x] **2.5b-2** — YouTube playlist router (Data API, no OAuth); children re-derive their own concepts. PR #33.
- [x] **2.5b-3** — Doc-site TOC router: fetch HTML → LLM selects ordered lesson links from real anchors (single_lesson / lesson_sequence / reference_index three-way) → URL-validated children. PR #34.
- [x] **2.5b-4** — Seed-library backfill + oversize gate (`DECOMPOSITION_MAX_AUTO_CHILDREN=50`; >50 → `human_review`) + parallel concept derivation. PR #35.
- [x] **2.5b-5** — `/playground/human-review` queue page (observable, read-only). PR #37.
- [x] **2.5b-6** — Decomposition-review **curation API** (`POST /api/playground/decomposition-review`): `accept_atomic` / `reject` / `decompose` (force bypasses the oversize gate). New `withAdminAuth` operator/agent auth wrapper (sibling to `withAuth`; diverges in Phase 3). Returns a `reason` so an autonomous reviewer can decide whether to retry. PR #38.
- [x] **2.5b-7** — Per-row curation buttons wired into the queue page. PR #42.
- [x] **2.5b-8** — **Manual decomposition** (`decompose_manual`): operator/agent supplies the ordered child list for client-rendered SPA courses the scrape routers can't read; `manual.ts` is the third link-source router into the shared sink. Also raised the child-insert transaction timeout (Prisma's 5s default aborted 100+ child courses). PR #40.
- [x] **2.5b-9** — "Decompose manual" button + paste-a-list modal (`url | title` lines → JSON `children`). PR #41.

**Beyond the original plan:**

- **Curation layer** (review API + buttons + manual action). The original sketch ended at "fallback → human_review, container exists but unpickable"; we added the actions to _resolve_ that queue — by a human or an agent — not just observe it. Designed agent-first (discriminated-union JSON body, `reason` passthrough).
- **SPA / headless escape hatch.** Khan-style SPAs render lessons client-side, so the scrape routers park them in `human_review`. `decompose_manual` lets a human or browser agent supply the ordered lessons. Verified end-to-end by driving a headless browser over Khan's Linear Algebra course (138 atomic children, ordered, concept-tagged, embedded). The proper fix — a **headless-render agent decomposer** that POSTs `decompose_manual` itself — is deferred to post-Phase-3 (avoids a Playwright/Chrome dependency on Vercel; see hosting portability in AGENTS.md). Until then a `decompose-spa` Claude Code skill (`.claude/skills/`) is the manual bandaid.
- Queue path is `/playground/human-review`, not the `/playground/decomposition-queue` name originally sketched.

Carried into the Path builder (2.5e): prefer **same-parent cohesion** when attaching sibling atomic children as concept candidates (non-pickable rows are already filtered via AR-2's hybrid search).

### Data model changes (summary)

The build sequence below lands these incrementally. Coexistence is the sequencing constraint: `Track`/`Progress`/`EnrolledPath` are **inert** (zero consumers) → free to reshape now; `Path`/`PathItem` are **live** (path-service writes them, the reject pipeline reads them) → the new structures land _alongside_, the flow cuts over, `PathItem` retires last.

- **New** — `Concept` (Path-scoped: `pathId`, per-Path `slug`, `title`, `membership ∈ {spine, frontier}`), `ConceptPrereq` (directed intra-Path edge `fromConceptId → toConceptId`, cycle-validated), `ConceptResource` (`conceptId`, `resourceId`, `role ∈ {teaches, uses, assesses}`, `coverageScore`).
- **`Path`** — add canonical-topic uniqueness + a readiness status (spine-ready gates the first Track); drop `createdById`, `difficulty`, `inputPriorKnowledge`/`inputTimeframeWeeks`/`inputHoursPerWeek`, and the user-facing title (those move to Track). _(Retired with PathItem at cutover.)_
- **`Track`** — drop `pathId @unique`; add the per-learner inputs + user-facing title/summary; cardinality-flavor discriminator left out until that decision lands. `status` lifecycle already exists.
- **`EnrolledPath`** — reference the pinned `trackId` (keep `pathId` for cross-version queries).
- **`Progress`** — re-key from `pathItemId` to `lessonId`.
- **`PathItem`** — retired at cutover (2.5g).

### Builders

- **Path builder (map-builder)** — per topic: authors the spine `Concept`s + prereq edges (cycle-validated), attaches existing-library candidates as `ConceptResource`s with role + coverage. Spine build is **synchronous** (gets-or-creates the Path under a lock so concurrent first-requests don't double-build) and sets the Path `spine-ready`. Frontier concepts + extra candidates **thicken async**. Launch-topic spines are seeded. Concept canonicalization is a within-map match-or-create.
- **Track builder** — per request over a `spine_ready` Path: **compose** (one Gemini-2.5-Pro judgment pass — infer `intent` from the learner's free-text goal, prune concepts they already know _including spine_, choose frontier depth, and grade each lesson into a coarse `timeWeight` bucket + a ranked **mandatory complementary core** (may span `teaches`+`assesses`) + an optional pool) → **validate** (inclusion-closure, DAG order, ≥1-resource fallback) → **allocate** (deterministic, no LLM: `timeWeight × budget` → per-lesson minute slices with 10% slack; fill the core rank-first into **multiple `primary`s**, trim frontier breadth closure-aware at floor cost) → emit ordered `Lesson`s with the multiple `primary` core + frozen `alternate` substitute pool (`orderInLesson`) → fan out exercise generation → freeze the snapshot. The single-primary/coverage-greedy/budget-blind first cut was **redesigned mid-phase** (see 2.5e sub-blocks).

### Block sequence (each <300 LOC, one PR per block)

- [x] **2.5c — Additive schema + inert re-keys.** New `Concept` / `ConceptPrereq` / `ConceptResource` tables; `Track` drops `@unique` + gains inputs/title; `EnrolledPath → trackId`; `Progress → lessonId`; `Path` gains readiness status. Leaves `Path`/`PathItem`/`path-service` untouched and working. Migration + Prisma client only.
- [x] **2.5d — Path builder: spine.** `lib/agents/map/` — author canonical spine concepts + prereq edges (cycle validation) for a topic, attach existing-library candidates, get-or-create the Path under a lock, set `spine-ready`. Seed the 4 launch-topic spines. Playground inspector for the map.
- [~] **2.5e — Track builder.** `lib/agents/track/` — compose → validate → allocate → freeze an immutable Track. (Exercises deferred to 2.5h.) Verifiable via the inspector before the playground render lands. **Shipped as a stacked PR chain (#65–#76, merge bottom-up), pending merge:**
  - [x] **2.5e-1** planner scaffold + `Track.targetMastery` (#65).
  - [x] **2.5e-2 / -2b** composer (one Gemini-2.5-Pro judgment pass) + deterministic re-validation — inclusion-closure, DAG order, prereq-closure (#66, #68).
  - [x] **2.5e-3 / -4** orchestrator + thickener seam; playground build trigger + read-only Track view (#69, #70).
  - [x] **2.5e-5** spine pruning — a learner who already knows a backbone concept can drop it; closure-safe, conservative (#71).
  - [x] **2.5e-6** intent — free-text `goal` → composer-inferred `TrackIntent` (`learn`/`review`/`practice`/`master`/`exam_prep`), persisted for downstream stages + analytics (#72).
  - [x] **2.5e-7** depth+breadth allocator. Composer grades each lesson into a coarse `timeWeight` + a ranked **mandatory complementary core** + optional pool; a pure allocator turns `timeWeight × budget` into per-lesson minute slices (largest-remainder, 10% slack), fills the core rank-first (≥1 guaranteed) and trims frontier breadth closure-aware → **multiple `role=primary` rows** (`orderInLesson`) + frozen alternates. (#73 allocator, #74 grading, #75 pipeline, #76 view + cleanup.)
  - Drove three fixes from real calculus Tracks: budget-blind selection, no spine pruning, no notion of intent.
- [ ] **2.5f — Async thickener + spine-hole remediation.** The standing map-builder worker. Three responsibilities: (1) add frontier concepts + extra candidate resources (the alternates) after the spine; (2) **remediate spine holes on a freshly-built `building` Path** (a thin/novel topic that didn't reach `spine_ready` synchronously); (3) handle the **spine-hole regression** (a hard-deprecated resource leaving a spine concept with no candidate → re-thicken). (2) and (3) are the same operation — targeted per-concept discovery (reuse `web-fallback.ts`) → validate/upsert/embed → re-attach + re-judge (reuse 2.5d-2) → recompute readiness — differing only in trigger. **Hole legitimacy (2.5d follow-up — evidence-based, deferred here):** before sourcing, classify each hole from its candidate coverage evidence. A _genuine gap_ (no resource teaches the concept; e.g. ML `unsupervised-learning-fundamentals`) is sourced via `web-fallback` as above. But a _conflation hole_ — an over-coarse concept where several `teaches@~0.4` candidates each cover a different slice and none clears the floor (the linear-algebra "Linear Independence, Basis, and Dimension" case) — is remediated by **SPLITTING the concept into finer nodes + re-attaching**, NOT by sourcing. The synchronous builder's semantic reviewer (2.5d `granularity` finding + author rule) catches most conflations at authoring time, but it is title-based and not guaranteed (a plausible-looking bundle can slip past); this post-attachment, coverage-evidence audit is the reliable backstop, and it lives here because the split-vs-source action is 2.5f's. **Remediation flow:** the request path (2.5g) calls `ensurePathMap`; if it returns `building`, it enqueues **one** remediation job for the Path and tells the user their course is being built. The worker single-flights per Path, fills holes, and on success flips `spine_ready` → builds the Track(s). **Exhaustion (per the locked decision): relax the bar first** (accept the best `uses`/below-floor `teaches` so the learner still gets a course), **then if a concept is still uncoverable, escalate to the human/agent review queue + page a developer.** Portable job infra (Postgres job table + worker; no Vercel Cron — see AGENTS.md) decided at block start. The "course ready" **email is deferred to Phase 3** (needs `User.email` from auth); until then the worker records readiness/escalation, no user email sent.
- [ ] **2.5g — Cutover.** Repoint the create flow (`createPath` → ensure-map + build-track); repoint the reject pipeline's `PathItem active→removed` flip to `ConceptResource` candidate-deprecation + the hard-severity live-Track alternate-promotion; **retire `PathItem`** and the Path user-specific columns once nothing reads them. **Reclaim non-self-healing Paths:** `ensurePathMap` currently returns _any_ existing Path as "exists, skip", so a `failed` Path (build threw) and a stale empty `building` Path (crash between claim and populate) both never retry — the request-path reclaim here must treat **both** as rebuildable (retry / delete-first), not just stale `building`.
- [ ] **2.5h — Content agent: exercises.** `lib/agents/content/` generates `Exercise` records (text/MCQ first) for gap-prone Lessons; fans out in parallel during track building. Cost ceiling per build.
- [ ] **2.5i — Delivery-mode classifier.** Per `LessonResource`, set `deliveryMode`. Embed allowlist + runtime header probe (`X-Frame-Options` / `CSP: frame-ancestors`) cached on `Resource`.
- [ ] **2.5j — Content agent: notebooks.** Agent emits `.ipynb` JSON via Gemini → storage → `Resource(type='interactive', origin='agent', status='pending_review')` → linked via `LessonResource`. Storage backend (Supabase Storage vs GCS) decided at block start.
- [ ] **2.5k — Playground: map + Track.** Render the concept map (spine/frontier, prereq edges, per-concept candidates) and a built Track (ordered Lessons, primary + alternates, delivery mode, inline exercises, notebook links). Track-build progress UI; inspector extended.

**Exit criteria:** a launch topic has a seeded spine map; requesting it builds a Track that (a) topo-respects the prereq DAG, (b) prunes concepts the learner declared known (including spine, conservatively) under an inferred `intent`, (c) fits the time budget — trimming frontier breadth _and_ sizing per-lesson depth by time-weight, (d) surfaces a ranked mandatory core (one or more primaries) plus a frozen optional/alternate pool on a Lesson, (e) has ≥1 agent-generated exercise; and rejecting a resource `hard` promotes an alternate (or flags) on an in-flight Track while excluding it from the next build.

### Deferred decisions (decide when the block is worked)

- **Track cardinality flavor** — per-enrollment snapshot vs. per-version. FK topology is fixed either way; pick when the Track builder's reuse/cost profile is known.
- **Path traversal at the topic edge** — does a Path **bound** the traversal (unmet external prereqs are "assumed" / handled by a Program) or **seed** it? Pin when the Program layer (2.75) firms up.
- **Async thickener infra** — Postgres job table + worker vs. opportunistic trigger-on-request. Portable, Cloud-Run-friendly (no Vercel Cron). Decided at 2.5f.
- **Remediation single-flight & subscriber model** — one remediation job per Path; concurrent requests for the same `building` topic should attach as extra subscribers, not spawn new jobs (the advisory-lock claim already gives single-flight for the _build_). The exact dedupe + subscription shape (a `CourseRequest`-style model: who-wants-this-topic, for the eventual "ready" email) is **deferred** — decide when the 2.5g request wiring / 2.5f worker is built.
- **"Course ready" notification** — emailing the requester when a `building` Path reaches `spine_ready` is **deferred to Phase 3**: it needs `User.email` (Supabase auth) + an email provider. The 2.5f worker is built auth-agnostic (records readiness/escalation); the email wire is a thin Phase-3 add.
- **Entity renaming** — Path→`Curriculum`/etc., Track→`Path`. Before a public UI exists, not during the playground phase.
- **Concept granularity policy** — how coarse/fine a `Concept` node is. Decide empirically during 2.5d once real spines exist.

### Open items for Phase 2.5

- **Segment refs for non-YouTube resources.** YouTube timestamps are clean. Doc anchors require fetching + parsing HTML headings. May need a fallback "describe the segment in prose" when no addressable anchor exists.
- **How "alternate" surfaces in UI.** Tabs? Stacked cards? "Try a different explanation" button? Decide during 2.5k; shapes the data model only lightly.
- **Exercise grading.** Reveal-only in 2.5, or wait for the Phase 4 tutor to grade? Lean reveal-only here.
- **Idempotency of track regen.** A failed/superseded Track must never corrupt the Path map. `Track.status='failed'` with diagnostic; a fresh build replaces rather than mutates (immutability holds).
- **"User knows X" → concept matching.** Pruning known concepts maps free-text `priorKnowledge` onto a Path's concept set — fuzzy. _Shipped in 2.5e-5/-6:_ the composer prunes from `priorKnowledge` + `goal` in its judgment pass (incl. spine, conservatively); no embedding match — the LLM does the mapping. Pruning **accuracy** still needs validation on real learner inputs; revisit if conservative-pruning leaves too much redundant or wrongly drops a needed concept.
- **Decomposition failure during discovery.** Transient YouTube API / scrape failures shouldn't nuke the discovery. Commit parent with `decompositionStatus='pending'`, retry via `scripts/retry-decomposition.ts` or on next touch. Parent stays unpickable until decomposed.
- **Discovery latency.** First user to trigger an off-library topic that finds a container pays the decomposition cost (~30s for a 30-video playlist). Accepted for now; revisit in 2.6 if it becomes a UX problem.
- **Headless-render agent decomposer (post-Phase-3).** Replaces the `decompose_manual` human bandaid for SPA courses (Khan Academy, etc.): an agent renders the client-side page, extracts the ordered lessons, and POSTs `decompose_manual` itself. Needs a rendering surface (connected Chrome, or a Cloud Run service with Playwright) — hence deferred until after the Cloud Run migration, to keep a browser dependency off Vercel.
- **Non-embeddable circumvention (revisit).** Options to weigh later: server-side proxy + rewrite (legal risk), agent-generated summaries (quality risk), reader-mode extraction.
- **Critic-triggered re-retrieval (carried from AR).** If the critic finds a gap needing a _different_ resource (not just reordering), v1 re-selects over the existing set only; looping back into retrieval is a future option.
- **Fallback floor never fills (audit 5.1) — now the ⭐ NEXT UP.** `ensureFloor` counts `status='active'` atomic rows, but discovery inserts `pending_review` and nothing promotes to `active`, so a full Gemini 2.5 Pro discovery loop re-fires on _every_ request for any seed-less, relation-less agent-grown topic. The topic redesign (#44/#45) wired `PENDING_REVIEW_GATE_PER_TOPIC` and widened both `ensureFloor` and search to the related set (so a related topic's seeds now satisfy the floor), but the core gap stands. Fix = the `pending_review → active` promotion pipeline, now the headline NEXT UP at the top of this file. Independent of the stampede/queue work (audit 5.2, deferred to Phase 3.1).
- **Pre-decompose dedup (audit 6.1) — cost; compounds 5.1.** Dedup is currently post-decompose: the existing-URL skip lives in `upsertResource` (last step), so re-discovering an already-stored playlist still runs liveness fetches + rules-agent Flash + full YouTube Data API decomposition + concept-derivation before discarding it at upsert. With 5.1 (re-fire every request), a popular cold topic re-pays YouTube quota + decompose cost on every request. Fix: skip URLs already in the library _before_ validate/decompose.
- **Batch post-commit embeds (audit 7.1) — efficiency.** The discovery/upsert path embeds one row at a time (a 50-child playlist = 50 sequential Vertex embedding calls) even though `embedMany` batches natively (the backfill path already uses 100/call). Collect `embedTasks`, embed in chunks of 100, then UPDATE. Also covers the "parallelize post-commit embeds" half of audit 5.4.

## Phase 2.6 — Frontend (was 2f/2g)

Public-facing surfaces. Deferred until after 2.5 because rendering Path-as-flat-list would be throwaway once the Lesson layer exists.

- [ ] **2.6a — Landing page `app/page.tsx`.** Dual-audience hero, form (7-topic dropdown, prior knowledge, timeframe), submit → redirect to `/path/[id]`.
- [ ] **2.6b — `app/path/[id]/page.tsx`.** Public read-only Track view: ordered Lessons with per-LessonResource delivery, primary + alternate resources, inline exercises, mark-complete (anonymous-friendly via local storage; migrates to DB on auth in Phase 3). Introduces public `GET /api/paths/[id]` returning the Track/Lesson projection.

**Exit criteria:** stranger from the landing page generates a path, lands on `/path/[id]`, sees the structured Track (not a flat link list), and can iframe-or-open Lessons and reveal exercises.

## Phase 2.75 — Multi-topic Programs (the differentiator)

A `Program` is a goal-driven plan composed of multiple single-topic `Path`s — e.g. "be ready for NUS Sem 1 CS AI by Aug 2026 given my background." This is the headline differentiator vs. course aggregators: most sites sell _a course_; we sell _a plan that gets you to your goal_.

### Shape

- `Program` owns N `Path`s (one per topic) via a join entity that adds **phase grouping** (e.g. "Month 1: math + PyTorch"), **cross-program order**, and **priority tier** (`core` / `nice_to_have`).
- `Program` inputs: a free-text **goal**, **background**, **total hours/week**, **deadline or total weeks**. Optionally an **anti-list** ("don't include LeetCode now").
- The **program agent** does three things the curriculum agent doesn't:
  1. **Topic decomposition** — goal + background → topic list with per-topic gap assessment.
  2. **Budget allocation** — distribute total hours across topics, weighted by gap × topic importance.
  3. **Cross-topic sequencing + phase grouping** — use existing `prerequisiteConcepts` / `conceptsTaught` to compute topic dependencies; group into phases.
- Each child Path is then generated by the existing 2b curriculum agent, called once per topic with the allocated `timeframeWeeks` / `hoursPerWeek`.

### Block sequence (each <300 LOC, one PR per block)

- [ ] **2.75a — Schema.** `Program(id, goal, background, totalHoursPerWeek, totalWeeks, antiList, createdBy?, …)`, `ProgramPath(programId, pathId, phaseLabel, orderInProgram, priorityTier)`. Migration only; no agent yet.
- [ ] **2.75b — `lib/agents/program-agent.ts`.** Goal + background + budget → topic decomposition + per-topic allocation + cross-topic dependency graph → fan out to curriculum agent in parallel → assemble `Program` + `ProgramPath` rows. Reuses 2b's curriculum agent unchanged.
- [ ] **2.75c — `POST /api/generate-program` route.** Validates body → calls program agent → persists in a single transaction.
- [ ] **2.75d — `app/program/[id]/page.tsx`.** Phased view: each phase is a section, each child Path renders its sequenced items with rationale. "If you only do three things" callout surfaces `priorityTier='core'` items across all child Paths.
- [ ] **2.75e — Landing-page entry point.** Add "Generate a Program" alongside the single-topic flow. Goal-driven form (free-text goal + background + budget).

**Exit criteria:** input like "Ready for NUS Sem 1 CS AI by Aug 2026, my background is full-stack TS with rusty math" produces a multi-topic Program with phased child Paths, per-path rationale, and a visible priority-tier fallback. Re-running the same goal with a tighter budget visibly drops `nice_to_have` items.

### Open items for Phase 2.75

- **Goal modeling depth.** Free-text goal + LLM-parsed topics is the simplest start. May need a structured goal schema if results are too fuzzy.
- **Budget allocator design.** Pure-LLM allocation vs. LLM topic-weights + deterministic distribution. Pure-LLM is faster to ship; deterministic gives more auditable budgets.
- **Cross-topic dependency confidence.** Concept-overlap works for seeded topics but may be sparse for web-fallback topics until 2c canonicalization matures.
- **Anti-list semantics.** Hard filter on Resources, a prompt constraint passed to the agent, or both?
- **Where do "practice milestones" live?** Items like "implement A\* on 8-puzzle" aren't existing Resources. May lean on Phase 2.5's `Exercise` to represent these as auto-generated milestones inside a Program.

## Phase 3 — Auth + Stripe (intentionally before tutor)

- [ ] Supabase Google OAuth via `@supabase/ssr`
- [ ] `app/pricing/page.tsx` — single tier, placeholder price
- [ ] `app/api/stripe/checkout/route.ts`, `app/api/stripe/webhook/route.ts` — webhook flips `User.plan = 'paid'`
- [ ] Free→paid gate enforced (free = 1 path + preview; paid = full access + tutor)
- [ ] Stripe **test mode** in dev

### Hardening `POST /api/generate-path` (from curriculum-agent audit, Section 1)

- [ ] **Rate limiting + access control (audit 1.1).** Today the route is gated only by the `DEV_AUTH=1` placeholder and is otherwise unauthenticated, unthrottled, and un-idempotent — anyone reaching the URL can trigger the app's most expensive operation (Gemini 2.5 Pro grounded search + validation fan-out + YouTube/embedding calls) without limit, draining Vertex spend, the YouTube 10k/day project quota, and pushing all traffic into Vertex DSQ deprioritization (429s). Replace the placeholder with the real Supabase session check and add a per-user rate limit + idempotency key (dedup on user + canonical topic + params).
- [ ] **Distinct admin gate (audit 9.1) — HIGH.** `withAuth` and `withAdminAuth` currently gate on the _same_ `DEV_AUTH=1` flag, so enabling generation also exposes the curation API (incl. `force`-decompose: bypasses the oversize gate, 100+ children, 120s tx), `markAtomic`/`markUnsupported`, and the human-review queue. When real auth lands, `withAdminAuth` must become a _role_ check distinct from the user session — not the shared flag.
- [ ] **Per-generation cost observability (audit 9.4).** Replace `console.log`-only with structured logs + a request/trace id, and persist per-job token cost (and the critique verdict, audit 8.4) on the async `PathGeneration` record so runaway cost is visible before the bill, not after.
- [ ] **CSRF for cookie sessions (audit 9.7).** Once Supabase cookie auth lands, state-changing POSTs (generate-path, curation) need CSRF defense, or enforce a non-cookie auth header.
- [ ] **Make path generation asynchronous (audit 1.2, 1.3).** Change the route to _enqueue_ a generation job and return `202 Accepted` with a job id immediately, rather than running the full gate → retrieval → fallback → select → critic → persist pipeline inside the HTTP request. The user is notified (poll the job status or push/email) when the path is ready. This removes the Vercel 60s `maxDuration` guillotine (cold-topic runs structurally exceed it — `ensureFloor` alone fans out to 3× Pro grounded-search) and the wasted spend from client disconnects. Introduce a `PathGeneration` job record (`status: queued|running|succeeded|failed`, `pathId` on success) as the ack target and the natural home for the idempotency key above. **Worker still needs explicit per-call `abortSignal`/timeouts + an overall job deadline/budget** — async stops the HTTP guillotine but a hung upstream call would otherwise pin a worker indefinitely.

**Exit criteria:** unauthenticated → Google sign-in → generate path (returns a job id; notified on completion) → pricing → checkout (test card) → webhook unlocks paid features.

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

- [ ] **Health-probe auth (audit 9.2).** `GET /api/health?probe=ai` is unauthenticated and fires a live Flash call per hit (loopable → unbounded cost/DSQ); also leaks raw `err.message`. Gate `probe=ai` behind admin/secret + rate-limit; keep plain liveness public.
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
