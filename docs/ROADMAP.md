# Roadmap — Adaptive Learning Path (90-Day AI Venture)

This roadmap mirrors the build order from the original spec (`learning-path-mvp-spec.md`, §9) and is the source of truth for what we're working on next. Edit as the project evolves.

## Locked decisions

| Area | Choice | Why |
|---|---|---|
| Niche | Tech upskillers + students (math/science) | Broad free-content pool, dual-audience landing |
| Launch topics (seeded) | Python for data/ML, JS+React, Calculus, Linear Algebra | All four have massive free-content pools to aggregate |
| AI provider | Vertex AI (Gemini) from day 1 | GCP credits available; credits don't apply to plain Gemini API key |
| DB + Auth | Supabase (Postgres + Google OAuth) | One provider for DB, auth, RLS; matches "Google sign-in only" |
| Payments | Stripe Checkout, single subscription, price TBD | Spec-mandated; revenue is a competition criterion |
| Styling | Tailwind CSS | Per spec |
| Hosting | Vercel now → Cloud Run later | Fast start; Cloud Run later adds a 2nd GCP product + uses credits |
| ORM | Prisma over Postgres (Supabase-hosted) | Per spec |
| Resource library | Postgres `Resource` table, agent-extensible | Library compounds with use; Phase 2 agent writes vetted finds back so quality grows over time (decided during 1b discussion) |

## Phase 1 — Foundation

Goal: a runnable Next.js scaffold + repo conventions + Vertex/Gemini proven end-to-end.

- [x] **Initialization** — `create-next-app`, `CLAUDE.md`, `docs/ROADMAP.md`, `.env.example`, initial commit on `main`
- [x] **Feature 1a — Vertex/Gemini hello-world.** `/api/health` route calls Gemini via Vertex; installs `ai` + `@ai-sdk/google-vertex`; GCP project + service account set up.
- [x] **Feature 1b — Seed library.** Postgres `Resource` table (Prisma 7) seeded with ~10 hand-curated entries per launch topic (39 total). Schema supports the Phase 2 growth loop: `slug`, `topic`, `title`, `url`, `type`, `tier`, `durationMin`, `summary`, `difficulty`, `prerequisiteConcepts[]`, `conceptsTaught[]`, `requiresPurchase`, `source` (`seed`/`agent`/`user`), `status` (`active`/`deprecated`/`pending_review`). Curation rules in [`data/README.md`](../data/README.md). Originally scoped as a flat JSON; expanded to DB after discussion locked in "library-as-moat" (see Phase 2). PRs #2–#4.
- [x] **Feature 1c — Vercel deploy.** Env vars wired in Vercel dashboard (Vertex creds + `DATABASE_URL` + `DIRECT_URL`); `/api/health` works in prod; production DB migrated + seeded. Live at <https://learning-app-three-amber.vercel.app/>. PRs #10, #11.

**Exit criteria:** `/api/health` returns a Gemini-generated string in prod, AND the Resource library is migrated + seeded in the production Supabase database.

## Phase 2 — Path generation + library growth agent (spec §7)

### Locked decisions (resolved during phase planning)

| Decision | Choice |
|---|---|
| Path ↔ User relation | `Path.createdBy` is a **nullable FK** to `User`. Separate `EnrolledPath` join table links users to paths they're working through. In Phase 2 (no auth) `createdBy` stays null. |
| Path access | Paths are public resources. Subscribed users access any path; seeded "root" paths public to all. URL-based access in Phase 2 (no auth gate yet). |
| `pending_review` visibility | Show immediately in generated paths for now. **Per-topic gate**: once a topic has ≥ N `active` Resources, exclude `pending_review` from that topic's generation. N starts at 10 in `src/lib/config.ts` and is tunable. |
| Web fallback | Vertex Gemini with grounded Google Search (single call, built-in citations). Not an agent-with-tools loop. **Superseded by Phase 2.5-AR**: the discovery call stays a single grounded-search call, but it becomes a *tool* the redesigned curriculum agent's retrieval loop can invoke (`triggerWebFallback`), rather than being driven only by app-layer code. |
| Topic dropdown | 4 seeded + **Machine Learning, Statistics, Go** = 7 options. The last three deliberately stress the web-fallback + cache-back loop. |
| Concept-tag normalization | LLM canonicalization at insert time. No embeddings/pgvector in Phase 2. **Superseded by Phase 2.5-AR**: pgvector + Vertex embeddings land in AR-1 as the enabling primitive for scaled retrieval and 2.5c dedup. Canonicalization stays; embeddings are added alongside it. |
| Phase-5 columns | `PathItem.isCheckpoint`, `PathItem.branchOnFail` get created in 2a but stay inert. |
| Path regeneration | Same input = fresh path each time. No caching. |
| Model selection | Central agent → model registry at `src/lib/models.ts`. Each agent has a default `{ modelId, temperature, maxTokens }`, overridable by env var (e.g. `MODEL_CURRICULUM=…`). Phase 2 wires Gemini 2.5 Flash everywhere; abstraction ships so model swaps are config, not refactor. |
| Billing modeling | Separate `Subscription` table from day 1 (scaffold in 2a, populated in Phase 3), not a `plan` column on `User`. Acknowledges billing belongs in its own aggregate; avoids a schema migration when Stripe lands. |
| Generation inputs storage | `Path.inputPriorKnowledge`, `Path.inputTimeframeWeeks`, `Path.inputHoursPerWeek` live on `Path`, not `EnrolledPath`. These shape *what content* the agent picks (not just pacing), so storing on `Path` keeps the artifact reproducible and per-item rationale auditable. Trade-off: less Path reuse across users with similar inputs; acceptable because "no caching" is locked and dedup belongs at the agent layer if it ever matters. |
| Path scope | `Path` is **single-topic by design**. Multi-topic, goal-driven plans (e.g. "ready for NUS Sem 1 by Aug 2026") compose Paths via a future `Program` layer in Phase 2.75. The 2b curriculum agent's interface stays narrow (`{ topic, priorKnowledge, timeframeWeeks, hoursPerWeek } → sequenced items`) so a program agent can call it per-topic without refactor. |

### Block sequence (each <300 LOC, one PR per block)

- [x] **2a — Prisma schema additions.** `User` (minimal), `Subscription` (scaffold), `Path(createdBy nullable FK, input* snapshot)`, `PathItem(status, isCheckpoint, branchOnFail)`, `EnrolledPath`, `Progress`. (`Resource` table landed in Feature 1b.) PR #14.
- [x] **2b — Curriculum agent (library-first) + model registry.** `src/lib/models.ts` + `src/lib/curriculum-agent.ts` doing library-first matching against `Resource` (filters on topic, difficulty, prerequisite/taught concepts), Gemini sequencing + per-item `rationale`. Refactored `/api/health` onto the registry. PR #17.
- [x] **2c — Web fallback + cache-back + tag canonicalization.** Vertex-grounded Google Search when topic ∉ seeded set or library candidates < threshold. LLM tag canonicalization against existing topic vocab. Upserts finds as `Resource(origin='agent', status='pending_review')`. Per-topic ≥10 active gate. Includes 2c.5 validity loop (discover/validate). PRs #18, #19.
- [x] **2d — `POST /api/generate-path` route + `PathService`.** Validates body → calls agent → creates `Path` + `PathItem` rows in a single transaction. Hardens against agent cuid hallucination. PRs #20, #21.
- [x] **2e — Agent playground (`/playground`).** Internal-only, `DEV_AUTH`-gated. Free-text form posts to `/api/generate-path`; detail page renders the persisted Path with items + clickable resource URLs and a raw-JSON inspector. Index lists recent paths. PR #22.

**Exit criteria (met):** stranger fills the playground form → sees a real sequenced path with per-item rationales. Off-library topics (Go / ML / Statistics) visibly grow the `Resource` table via the web-fallback + cache-back loop.

### Discoveries during 2e that reshape what's next

The playground surfaced two problems with treating a Path as a flat resource list:

1. **Whole-course resources overlap.** When two PathItems are themselves multi-topic courses (e.g. two Python courses), they cover the same concepts (loops, functions, etc.). The Path becomes redundant.
2. **Leaky delivery.** Items that link out to YouTube playlists, full courses, or doc trees expect the learner to navigate inside the external site. That kills our progress tracking, our future tutor agent's context, and our retention.

Conclusion: a `Path` of curated links is the right *generation* artifact, but not the right *delivery* artifact. We need a layer above PathItem that turns curated resources into a structured, lesson-by-lesson experience — closer to Khan Academy / Coursera in shape, but built from heterogeneous web resources. That is Phase 2.5 below (rescoped from "content-generating agent").

## Phase 2.5 — Structured Track Agent (rescoped)

Originally scoped as "agent-generated exercises and notebooks." Rescoped after the 2e discoveries above: the lesson layer is the missing primitive; exercises and notebooks **attach to lessons**, not directly to PathItems.

Two distinct concerns, both belong to this phase:

1. **Decomposition is a *library* concern, not a track concern.** Container resources (YouTube playlists, doc trees, whole courses) are decomposed into atomic child Resources **at discovery time**, once, and cached. The curriculum agent only picks atomic, pickable Resources. This means our resource library grows in atomic units over time, and decomposition becomes less of a problem as the library matures.
2. **Track creation composes, dedups, and classifies.** Given a `Path` of atomic PathItems, the Track agent produces a `Track` of ordered `Lesson`s, surfaces cross-resource concept duplicates as Lessons-with-alternates, classifies per-resource delivery mode (embed vs new-tab vs native), and triggers exercise/notebook generation for gap-prone Lessons. **No decomposition at track time.**

### Locked decisions

| Decision | Choice |
|---|---|
| Naming | `Track` for the structured wrapper; `Lesson` for the unit. Avoids collision with "course" as a resource type. |
| Where decomposition lives | **Resource-discovery time, not track-creation time.** Decomposed once, cached on Resource forever. Inside the 2c discovery flow: classify type → if container, fetch outline + decompose → upsert parent + N children in one transaction. Discoverer pays the cost; future track generations are free. |
| Container resources | `course`-typed Resources still exist but are **container-only** — never picked by the curriculum agent. Atomic children link via `Resource.parentResourceId` + `Resource.orderInParent`. Containers carry overall arc metadata (title, summary, author intent) that gives the curriculum agent a cohesion signal. |
| Decomposition router | Ship **YouTube playlists (Data API) + doc-site TOC scrape + "single = atomic" fast-path** first. Paid platforms (Coursera/Udemy/edX) deliberately out of scope — login/paywall problems aren't worth solving. Unsupported types fall back to `human_review` queue; container row exists but is unpickable until curated. |
| Decomposition status | Single field: `Resource.decompositionStatus ∈ {atomic, decomposed, pending, unsupported, human_review}`. Atomic + decomposed-children are pickable; the rest aren't. Replaces a separate `pickable` flag. |
| Concept re-derivation on decompose | Children re-derive `conceptsTaught` from their own title/transcript, not inherited slices of the parent's concepts. Dedup accuracy depends on it. |
| Duplicate handling | **Detection at track time, not prevention.** Two atomic Resources covering the same concept → collapsed into one Lesson with `primary` + `alternate` `LessonResource`s. Alternate explanations on the same concept are a learner-value feature. |
| Non-embeddable delivery | **Open in new tab + "mark complete" return-flow.** Iframe where allowed (YouTube embeds, most docs); new-tab where blocked. Revisit later for proxying / summaries / reader-mode — all have tradeoffs to weigh then. |
| `deliveryMode` location | On **`LessonResource`**, not `Lesson`. A single Lesson can mix embeddable video + new-tab article + native exercise; mode is per-resource-in-this-context. |
| PathItem's role under Tracks | PathItem stays as the **curriculum-agent's record of intent** — what it picked and why. Rationale is preserved and visible. The Track agent reads PathItem rationales when composing Lessons; LessonResource references Resource directly (not via PathItem). PathItem becomes effectively an audit log. |
| Track ↔ Path relationship | `Track.pathId` unique (1:1). `Track.status ∈ {pending, building, ready, failed}` for sync-lazy generation. |
| Generation timing | **Sync-lazy.** `/api/generate-path` still returns the Path immediately (unchanged). Track building happens on first visit to `/playground/path/[id]` (later `/path/[id]`), with a visible progress UI. Exercises/notebooks lazy-load per Lesson within that. |
| Where exercises live | `Exercise` attaches to `Lesson`, not `PathItem` or `Resource`. Notebooks become Resources of `type='interactive'`, `origin='agent'`, linked from a Lesson via LessonResource. |
| Path/PathItem retained alongside Track/Lesson | **Keep both layers.** Path = selection record (what the curriculum agent picked + rationale). Track = delivery structure (post-processed, dedup'd, with generated content). 1:1 today but different responsibilities, costs, and lifecycles: Track can be regenerated without re-running expensive library matching + web fallback; PathItem rationales survive dedup at their source layer; Phase 2.75 Program agent needs the cheap "picked resources" tier for budget allocation before committing to Track-building. **Revisit at end of 2.5g**: if dedup rarely fires and Tracks end up structurally near-identical to Paths, collapse the two layers (the migration direction is clean). |

### Block sequence (each <300 LOC, one PR per block)

- [ ] **2.5a — Schema additions.** Migration only.
  - `Resource` adds: `parentResourceId` (self-FK), `orderInParent`, `decompositionStatus`.
  - `Track(id, pathId unique, status, …)`
  - `Lesson(id, trackId, orderInTrack, title, summary, conceptsTaught[], estMinutes)`
  - `LessonResource(lessonId, resourceId, role: 'primary'|'alternate', deliveryMode: 'embed'|'newtab'|'native', segmentRef?)` — `segmentRef` carries YouTube timestamps / doc anchors when a Lesson uses only part of a resource.
  - `Exercise(lessonId, prompt, answer, rubric, kind, origin)`.
  
#### Phase 2.5-AR — Curriculum Agent Redesign (lands after 2.5a, before 2.5b)

The 2b curriculum agent is a **single `generateText` call**: `loadCandidates(topic)` does an exact-match `WHERE topic = ? AND status = 'active'`, serializes every candidate into the prompt, and the model picks by 1-based positional index. That holds while per-topic libraries are small, but **2.5b breaks it** — decomposition explodes containers into dozens of atomic child Resources, so a topic can no longer be dumped wholesale into context. The agent also can't search the library, can't decide its own retrieval moves, and can't review its own output. AR turns it into a real multi-step, tool-calling agent before the Track agent (2.5c) inherits the pattern.

**Architecture: Hybrid.** An autonomous tool-calling *retrieval loop* (the model decides when to search, broaden, or fall back) hands a fixed candidate set to a *deterministic* select → critic → revise pipeline that produces the customer-facing artifact. Agentic where flexibility pays; auditable and verifiable where correctness matters. This shape becomes the template for the Track (2.5c), Content (2.5e/f), and Program (2.75b) agents.

##### Locked decisions

| Decision | Choice |
|---|---|
| Control flow | Hybrid: autonomous loop for retrieval only; deterministic select → critic → revise for output. Not a single fully-autonomous loop (cost/latency/verifiability) and not a pure deterministic workflow (retrieval needs to be agentic). |
| Retrieval primitive | **pgvector + Vertex embeddings.** Reverses "no embeddings/pgvector in Phase 2." Justified as the primitive for scaled retrieval *and* 2.5c concept-dedup, not a curriculum-only nicety. |
| Search shape | **Hybrid, never pure vector.** Structured filters first (`topic`, `status`, pickability via `decompositionStatus`), then vector rank within that set. |
| Cost threshold | If a topic has ≤ ~30 pickable candidates, return them all (today's load-all behavior); vector ranking only engages above that. Keeps the common case cheap. |
| What gets embedded | `title + summary + conceptsTaught`, one embedding per Resource, embedded at insert time. |
| Web fallback | Becomes a tool (`triggerWebFallback`) the retrieval loop can call; the call itself stays a single grounded-search call (unchanged internally). |
| Anti-hallucination | Positional-index trick doesn't survive tool-based retrieval (resources arrive as tool results, not a numbered prompt list). Replaced by **opaque handles**: tools return short session-scoped IDs; any submitted ID is validated against what was actually returned this session. |
| Self-review | **Separate** critic call (not self-grading in the same context) against an explicit rubric, returning structured findings, feeding a **bounded** revise loop (max 2 retries). New `criticAgent` entry in the model registry. |
| Emit mechanism | **Confirmed in AR-3** (throwaway probe): combining `tools` + `Output.object` in one `generateText` call does *not* throw, but produces **no structured output** (`experimental_output` getter throws "No output generated") — the provider drops the response schema when tools are present. AR-4 therefore emits via a **separate `Output.object` call with no tools** over AR-3's gathered candidate set (the path `curriculum-agent.ts` already uses). Hybrid C isolates retrieval from emit, so the conflict never arises in practice. |

##### Block sequence (each <300 LOC, one PR per block)

- [ ] **AR-1 — pgvector + embeddings + backfill.** Migration: enable the `vector` extension, add `Resource.embedding` (+ ivfflat/hnsw index). Embed-on-insert wired into the 1b seed path and the 2c discovery upsert via a Vertex embedding model added to the model registry. `scripts/embed-resources.ts` backfills existing rows. Migration + embedding plumbing only; no agent changes yet.
- [ ] **AR-2 — `searchResources` hybrid search + tool wrapper.** Pure function: structured filters → vector rank, with the ≤30 fast-path. Wrapped as an AI SDK `tool()`. Unit-testable in isolation.
- [ ] **AR-3 — Retrieval loop (autonomous half).** Bounded tool-calling loop with `searchResources`, `getResourceDetails`, `triggerWebFallback`; returns an assembled candidate set keyed by opaque handles. Confirms the SDK's tools + structured-output behavior to lock AR-4's emit mechanism.
- [ ] **AR-4 — Deterministic select → emit.** Consumes AR-3's candidate set, sequences + writes per-item rationale, emits via the AR-3-confirmed mechanism. Replaces today's single `generateCurriculum` call while preserving its `CurriculumInput`/`CurriculumOutput` contract so `/api/generate-path` and `PathService` are untouched.
- [ ] **AR-5 — Rubric critic + revise loop.** Separate `criticAgent` scores the emitted path (prerequisite ordering, budget fit, whole-course redundancy, difficulty match, rationale specificity) → structured findings → bounded revise. Surfaced in the playground's raw-JSON inspector.

**Exit criteria:** the curriculum agent issues multiple `searchResources` calls against a topic whose library exceeds the load-all threshold, picks only pickable Resources by opaque handle (no fabricated IDs), triggers web fallback as a tool when the library is thin, and emits a path that has visibly passed (or been revised by) the rubric critic — all while keeping the `CurriculumInput → CurriculumOutput` contract so downstream routes are unchanged.

##### Open items for Phase 2.5-AR

- **Embedding model + dimensions.** Which Vertex `text-embedding` model, and the resulting vector dimension (fixes the migration column + index). Decide at AR-1.
- **Index type.** ivfflat (needs `lists` tuning + a populated table to train) vs hnsw (better recall, heavier build). Library is small now; revisit as it grows.
- **Loop step ceiling + token budget.** `stopWhen: stepCountIs(N)` value, and per-call token accounting now that one generation fans into many calls. Tie into the observability TODO already in `curriculum-agent.ts`.
- **Critic-triggered re-retrieval.** If the critic finds a gap that needs a *different* resource (not just reordering), does AR-5 loop back into AR-3's retrieval, or only re-run AR-4 select over the existing set? Lean re-select only in v1; note the limit.

- [ ] **2.5c — Track agent (composition + dedup).** `lib/track-agent.ts` takes a persisted Path → groups PathItems' Resources into ordered Lessons (factoring in each PathItem's rationale), detects cross-resource concept overlap, collapses duplicates into Lessons-with-alternates with `primary` selected by trust score + path order. Writes a `Track` with `status='building'` → `'ready'`. Triggered lazily on first `/playground/path/[id]` visit.
- [ ] **2.5d — Delivery-mode classifier.** Per `LessonResource`, set `deliveryMode`. Known-good embed allowlist (YouTube, MDN, Python docs, etc.) + runtime header probe (`X-Frame-Options` / `CSP: frame-ancestors`) cached on `Resource`. Native = agent-generated content we host.
- [ ] **2.5e — Content agent: exercises.** `lib/content-agent.ts` generates `Exercise` records (text/MCQ first) for Lessons flagged gap-prone (source resource has no native exercises, concept is foundational). Fans out in parallel during track building.
- [ ] **2.5f — Content agent: notebooks.** Agent emits `.ipynb` JSON via Gemini, uploaded to storage, registered as `Resource(type='interactive', origin='agent', status='pending_review')`, linked into a Lesson via LessonResource. Storage backend (Supabase Storage vs GCS) decided at start of block.
- [ ] **2.5g — Playground updates.** `/playground/path/[id]` renders the Track/Lesson structure: ordered Lessons, primary + alternate resources, per-LessonResource delivery mode, embedded iframe where applicable, inline exercises, "Open in Colab" for notebooks. Track-building progress UI for sync-lazy generation. Raw-JSON inspector extended to Track/Lesson.

**Exit criteria:** running the playground on a topic that pulls in a YouTube playlist or doc tree produces a Track where (a) the container is decomposed into atomic child Resources in the library, (b) overlapping concepts across different source resources are visibly surfaced as alternates on a shared Lesson, (c) LessonResources have a delivery mode and embed where allowed, (d) at least one Lesson has an agent-generated exercise and one has an agent-generated notebook, and (e) the `human_review` queue is observable in the playground.

- [ ] **2.5b — Decomposition pipeline at discovery + seed backfill.** `lib/decomposition-agent.ts` with a router: YouTube playlists via Data API, doc-site TOC scrape, atomic fast-path, fallback → `human_review`. Wired into 2c's discovery flow synchronously: classify → decompose → commit parent + children in one transaction. Includes `scripts/decompose-seed-library.ts` to migrate existing course-type rows from 1b. Also: extend curriculum agent to skip non-pickable Resources and prefer same-parent cohesion. Playground gains a `/playground/decomposition-queue` view for the `human_review` queue.

### Open items for Phase 2.5

- **Segment refs for non-YouTube resources.** YouTube timestamps are clean. Doc anchors require fetching + parsing HTML headings. May need a fallback "describe the segment in prose" when no addressable anchor exists.
- **How "alternate" surfaces in UI.** Tabs? Stacked cards? "Try a different explanation" button? Decide during 2.5g; shapes 2.5c data model only lightly.
- **Lesson concept-purity vs multi-concept.** Smaller Lessons dedup better but fragment pacing. Decide empirically during 2.5c.
- **Exercise grading.** Reveal-only in 2.5, or wait for Phase 4 tutor to grade? Lean reveal-only here.
- **Cost ceiling per track build.** Exercises + notebooks fanned out per Lesson can be expensive. Cap generated content (notebooks especially) to N per Track.
- **Idempotency of track regen.** Track failures shouldn't poison the Path. `Track.status='failed'` with diagnostic; regen replaces.
- **Decomposition failure during discovery.** Transient YouTube API / scrape failures shouldn't nuke the discovery. Commit parent with `decompositionStatus='pending'`, retry via `scripts/retry-decomposition.ts` or on next touch. Parent stays unpickable until decomposed.
- **Discovery latency.** First user to trigger an off-library topic that finds a container pays the decomposition cost (~30s for a 30-video playlist). Accepted for now; revisit in 2.6 if it becomes a UX problem.
- **Non-embeddable circumvention (revisit).** Options to weigh later: server-side proxy + rewrite (legal risk), agent-generated summaries (quality risk), reader-mode extraction.

## Phase 2.6 — Frontend (was 2f/2g)

Public-facing surfaces. Deferred until after 2.5 because rendering Path-as-flat-list would be throwaway once the Lesson layer exists.

- [ ] **2.6a — Landing page `app/page.tsx`.** Dual-audience hero, form (7-topic dropdown, prior knowledge, timeframe), submit → redirect to `/path/[id]`.
- [ ] **2.6b — `app/path/[id]/page.tsx`.** Public read-only Track view: ordered Lessons with per-LessonResource delivery, primary + alternate resources, inline exercises, mark-complete (anonymous-friendly via local storage; migrates to DB on auth in Phase 3). Introduces public `GET /api/paths/[id]` returning the Track/Lesson projection.

**Exit criteria:** stranger from the landing page generates a path, lands on `/path/[id]`, sees the structured Track (not a flat link list), and can iframe-or-open Lessons and reveal exercises.

## Phase 2.75 — Multi-topic Programs (the differentiator)

A `Program` is a goal-driven plan composed of multiple single-topic `Path`s — e.g. "be ready for NUS Sem 1 CS AI by Aug 2026 given my background." This is the headline differentiator vs. course aggregators: most sites sell *a course*; we sell *a plan that gets you to your goal*, with the right mix of topics, weighted by your gaps, sequenced across phases.

### Shape

- `Program` owns N `Path`s (one per topic) via a join entity that adds **phase grouping** (e.g. "Month 1: math + PyTorch"), **cross-program order**, and **priority tier** (`core` / `nice_to_have`, surfacing the "if you only do 3 things" fallback).
- `Program` inputs: a free-text **goal**, **background**, **total hours/week**, **deadline or total weeks**. Optionally an **anti-list** ("don't include LeetCode now").
- The **program agent** does three things the curriculum agent doesn't:
  1. **Topic decomposition** — goal + background → topic list with per-topic gap assessment.
  2. **Budget allocation** — distribute total hours across topics, weighted by gap × topic importance for the goal.
  3. **Cross-topic sequencing + phase grouping** — use existing `prerequisiteConcepts` / `conceptsTaught` on Resources to compute topic dependencies; group into phases.
- Each child Path is then generated by the existing 2b curriculum agent, called once per topic with the allocated `timeframeWeeks` / `hoursPerWeek`.

### Block sequence (each <300 LOC, one PR per block)

- [ ] **2.75a — Schema.** `Program(id, goal, background, totalHoursPerWeek, totalWeeks, antiList, createdBy?, …)`, `ProgramPath(programId, pathId, phaseLabel, orderInProgram, priorityTier)`. Migration only; no agent yet.
- [ ] **2.75b — `lib/program-agent.ts`.** Goal + background + budget → topic decomposition + per-topic allocation + cross-topic dependency graph → fan out to curriculum agent in parallel → assemble `Program` + `ProgramPath` rows. Reuses 2b's curriculum agent unchanged.
- [ ] **2.75c — `POST /api/generate-program` route.** Validates body → calls program agent → persists in a single transaction.
- [ ] **2.75d — `app/program/[id]/page.tsx`.** Phased view: each phase is a section, each child Path renders its sequenced items with rationale. "If you only do three things" callout surfaces `priorityTier='core'` items across all child Paths.
- [ ] **2.75e — Landing-page entry point.** Add "Generate a Program" alongside the single-topic flow. Goal-driven form (free-text goal + background + budget).

**Exit criteria:** input like "Ready for NUS Sem 1 CS AI by Aug 2026, my background is full-stack TS with rusty math" produces a multi-topic Program with phased child Paths, per-path rationale, and a visible priority-tier fallback. Re-running the same goal with a tighter budget visibly drops `nice_to_have` items.

### Open items for Phase 2.75

- **Goal modeling depth.** Free-text goal + LLM-parsed topics is the simplest start. May need a structured goal schema (target competencies, deadline type, etc.) if results are too fuzzy.
- **Budget allocator design.** Pure-LLM allocation vs. LLM topic-weights + deterministic distribution. Pure-LLM is faster to ship; deterministic gives more predictable / auditable budgets.
- **Cross-topic dependency confidence.** Concept-overlap from `prerequisiteConcepts` / `conceptsTaught` works for seeded topics but may be sparse for web-fallback topics until 2c canonicalization matures.
- **Anti-list semantics.** Is it a hard filter on Resources, a prompt constraint passed to the agent, or both?
- **Where do "practice milestones" live?** The NUS-style plan has items like "implement A* on 8-puzzle" that aren't existing Resources. May need to lean on Phase 2.5's `Exercise` to represent these as auto-generated milestones inside a Program.

## Phase 3 — Auth + Stripe (intentionally before tutor)

- [ ] Supabase Google OAuth via `@supabase/ssr`
- [ ] `app/pricing/page.tsx` — single tier, placeholder price
- [ ] `app/api/stripe/checkout/route.ts`, `app/api/stripe/webhook/route.ts` — webhook flips `User.plan = 'paid'`
- [ ] Free→paid gate enforced (free = 1 path + preview; paid = full access + tutor)
- [ ] Stripe **test mode** in dev

**Exit criteria:** unauthenticated → Google sign-in → generate path → pricing → checkout (test card) → webhook unlocks paid features.

## Phase 4 — Tutor agent (deep feature — spec §6)

- [ ] `lib/tutor-agent.ts` — single agent, modes `tutor | quizzer | path_adjuster`
- [ ] `lib/prompts.ts` — one structured system prompt with mode switching
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
