# Roadmap — Adaptive Learning Path (90-Day AI Venture)

This roadmap mirrors the build order from the original spec (`learning-path-mvp-spec.md`, §9) and is the source of truth for what we're working on next. Edit as the project evolves.

## Status (as of 2026-06-02)

**Shipped:** Phases 1, 2, 2.5a (schema), and the full **2.5-AR curriculum-agent redesign**. The playground generates real sequenced paths end-to-end — library-first retrieval, pgvector search, web fallback, topic canonicalization, and a rubric critic — with a full agent trace.

**Next up:** **2.5b** (decomposition pipeline) → **2.5c–g** (Track/Lesson delivery layer) → 2.6 (frontend) → 2.75 (Programs) → 3 (auth + Stripe) → 4–6.

**Agent code layout:** agents live under `src/lib/agents/` (curriculum pipeline in `agents/curriculum/`, tools in `agents/tools/`, web-discovery validation in `agents/validation/`); shared AI primitives (`vertex`, `models`, `embeddings`) under `src/lib/ai/`. New agents (`decomposition`, `track`, `content`, `program`, `tutor`) land under `agents/`.

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
- `Path` is **single-topic by design**; multi-topic goals compose Paths via a `Program` layer (Phase 2.75). The curriculum agent's interface stays narrow (`{ topic, priorKnowledge, timeframeWeeks, hoursPerWeek } → sequenced items`).
- `Path.createdBy` is a nullable FK; `EnrolledPath` is a separate join table; `Subscription` is its own table (populated in Phase 3).
- Every agent resolves model config via the registry (`MODEL_*` env overrides).
- Generation inputs live on `Path` (reproducible artifact). Same input = fresh path; no caching.

**The 2e discovery that reshaped 2.5:** a Path of curated links is the right *generation* artifact but not the right *delivery* one — whole-course resources overlap (redundant coverage), and items linking into external sites kill progress tracking and the future tutor's context. So a **Lesson layer** sits above PathItem: structured, lesson-by-lesson delivery built from heterogeneous web resources. That is Phase 2.5.

## Phase 2.5 — Structured Track Agent

The lesson layer is the missing primitive; exercises and notebooks **attach to lessons**, not directly to PathItems. Two concerns:

1. **Decomposition is a *library* concern.** Container resources (YouTube playlists, doc trees, whole courses) are decomposed into atomic child Resources **at discovery time**, once, and cached. The curriculum agent only picks atomic, pickable Resources, so the library grows in atomic units over time.
2. **Track creation composes, dedups, and classifies.** Given a `Path` of atomic PathItems, the Track agent produces a `Track` of ordered `Lesson`s, surfaces cross-resource concept duplicates as Lessons-with-alternates, classifies per-resource delivery mode (embed vs new-tab vs native), and triggers exercise/notebook generation for gap-prone Lessons. **No decomposition at track time.**

### Locked decisions

| Decision | Choice |
|---|---|
| Naming | `Track` for the structured wrapper; `Lesson` for the unit. Avoids collision with "course" as a resource type. |
| Where decomposition lives | **Resource-discovery time, not track-creation time.** Decomposed once, cached on Resource forever. Inside the 2c discovery flow: classify type → if container, fetch outline + decompose → upsert parent + N children in one transaction. |
| Container resources | `course`-typed Resources are **container-only** — never picked by the curriculum agent. Atomic children link via `Resource.parentResourceId` + `Resource.orderInParent`. Containers carry arc metadata (title, summary, intent) as a cohesion signal. |
| Decomposition router | Ship **YouTube playlists (Data API) + doc-site TOC scrape + "single = atomic" fast-path** first. Paid platforms (Coursera/Udemy/edX) out of scope. Unsupported types fall back to `human_review`; container row exists but is unpickable until curated. |
| Decomposition status | Single field: `Resource.decompositionStatus ∈ {atomic, decomposed, pending, unsupported, human_review}`. Atomic + decomposed-children are pickable; the rest aren't. |
| Concept re-derivation on decompose | Children re-derive `conceptsTaught` from their own title/transcript, not inherited slices of the parent's concepts. Dedup accuracy depends on it. |
| Duplicate handling | **Detection at track time, not prevention.** Two atomic Resources covering the same concept → collapsed into one Lesson with `primary` + `alternate` `LessonResource`s. Alternate explanations are a learner-value feature. |
| Non-embeddable delivery | **Open in new tab + "mark complete" return-flow.** Iframe where allowed (YouTube embeds, most docs); new-tab where blocked. Proxy/summary/reader-mode revisited later. |
| `deliveryMode` location | On **`LessonResource`**, not `Lesson`. A single Lesson can mix embeddable video + new-tab article + native exercise. |
| PathItem's role under Tracks | PathItem stays as the **curriculum-agent's record of intent** (what it picked + why). The Track agent reads PathItem rationales when composing Lessons; LessonResource references Resource directly. PathItem becomes an audit log. |
| Track ↔ Path relationship | `Track.pathId` unique (1:1). `Track.status ∈ {pending, building, ready, failed}` for sync-lazy generation. |
| Generation timing | **Sync-lazy.** `/api/generate-path` returns the Path immediately (unchanged). Track building happens on first visit to `/playground/path/[id]`, with a visible progress UI. Exercises/notebooks lazy-load per Lesson. |
| Where exercises live | `Exercise` attaches to `Lesson`. Notebooks become Resources of `type='interactive'`, `origin='agent'`, linked from a Lesson via LessonResource. |
| Keep Path + Track both | **Keep both layers.** Path = selection record (what was picked + rationale). Track = delivery structure (dedup'd, with generated content). Different costs/lifecycles: Track regenerates without re-running library matching + web fallback; PathItem rationales survive dedup; the 2.75 Program agent needs the cheap "picked resources" tier for budget allocation. **Revisit at end of 2.5g**: if dedup rarely fires and Tracks end up near-identical to Paths, collapse the two layers. |

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

### Block sequence — remaining (each <300 LOC, one PR per block)

- [ ] **2.5b — Decomposition pipeline at discovery + seed backfill.** `lib/agents/decomposition-agent.ts` with a router: YouTube playlists via Data API, doc-site TOC scrape, atomic fast-path, fallback → `human_review`. Wired into 2c's discovery flow synchronously: classify → decompose → commit parent + children in one transaction. Includes `scripts/decompose-seed-library.ts` to migrate existing course-type rows from 1b. Also: extend curriculum agent to skip non-pickable Resources and prefer same-parent cohesion. Playground gains a `/playground/decomposition-queue` view for the `human_review` queue.
- [ ] **2.5c — Track agent (composition + dedup).** `lib/agents/track-agent.ts` takes a persisted Path → groups PathItems' Resources into ordered Lessons (factoring in each PathItem's rationale), detects cross-resource concept overlap, collapses duplicates into Lessons-with-alternates with `primary` selected by trust score + path order. Writes a `Track` with `status='building'` → `'ready'`. Triggered lazily on first `/playground/path/[id]` visit.
- [ ] **2.5d — Delivery-mode classifier.** Per `LessonResource`, set `deliveryMode`. Known-good embed allowlist (YouTube, MDN, Python docs, etc.) + runtime header probe (`X-Frame-Options` / `CSP: frame-ancestors`) cached on `Resource`. Native = agent-generated content we host.
- [ ] **2.5e — Content agent: exercises.** `lib/agents/content-agent.ts` generates `Exercise` records (text/MCQ first) for Lessons flagged gap-prone (source resource has no native exercises, concept is foundational). Fans out in parallel during track building.
- [ ] **2.5f — Content agent: notebooks.** Agent emits `.ipynb` JSON via Gemini, uploaded to storage, registered as `Resource(type='interactive', origin='agent', status='pending_review')`, linked into a Lesson via LessonResource. Storage backend (Supabase Storage vs GCS) decided at start of block.
- [ ] **2.5g — Playground updates.** `/playground/path/[id]` renders the Track/Lesson structure: ordered Lessons, primary + alternate resources, per-LessonResource delivery mode, embedded iframe where applicable, inline exercises, "Open in Colab" for notebooks. Track-building progress UI for sync-lazy generation. Raw-JSON inspector extended to Track/Lesson.

**Exit criteria:** running the playground on a topic that pulls in a YouTube playlist or doc tree produces a Track where (a) the container is decomposed into atomic child Resources in the library, (b) overlapping concepts across different source resources are visibly surfaced as alternates on a shared Lesson, (c) LessonResources have a delivery mode and embed where allowed, (d) at least one Lesson has an agent-generated exercise and one has an agent-generated notebook, and (e) the `human_review` queue is observable in the playground.

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
- **Critic-triggered re-retrieval (carried from AR).** If the critic finds a gap needing a *different* resource (not just reordering), v1 re-selects over the existing set only; looping back into retrieval is a future option.

## Phase 2.6 — Frontend (was 2f/2g)

Public-facing surfaces. Deferred until after 2.5 because rendering Path-as-flat-list would be throwaway once the Lesson layer exists.

- [ ] **2.6a — Landing page `app/page.tsx`.** Dual-audience hero, form (7-topic dropdown, prior knowledge, timeframe), submit → redirect to `/path/[id]`.
- [ ] **2.6b — `app/path/[id]/page.tsx`.** Public read-only Track view: ordered Lessons with per-LessonResource delivery, primary + alternate resources, inline exercises, mark-complete (anonymous-friendly via local storage; migrates to DB on auth in Phase 3). Introduces public `GET /api/paths/[id]` returning the Track/Lesson projection.

**Exit criteria:** stranger from the landing page generates a path, lands on `/path/[id]`, sees the structured Track (not a flat link list), and can iframe-or-open Lessons and reveal exercises.

## Phase 2.75 — Multi-topic Programs (the differentiator)

A `Program` is a goal-driven plan composed of multiple single-topic `Path`s — e.g. "be ready for NUS Sem 1 CS AI by Aug 2026 given my background." This is the headline differentiator vs. course aggregators: most sites sell *a course*; we sell *a plan that gets you to your goal*.

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
- **Where do "practice milestones" live?** Items like "implement A* on 8-puzzle" aren't existing Resources. May lean on Phase 2.5's `Exercise` to represent these as auto-generated milestones inside a Program.

## Phase 3 — Auth + Stripe (intentionally before tutor)

- [ ] Supabase Google OAuth via `@supabase/ssr`
- [ ] `app/pricing/page.tsx` — single tier, placeholder price
- [ ] `app/api/stripe/checkout/route.ts`, `app/api/stripe/webhook/route.ts` — webhook flips `User.plan = 'paid'`
- [ ] Free→paid gate enforced (free = 1 path + preview; paid = full access + tutor)
- [ ] Stripe **test mode** in dev

**Exit criteria:** unauthenticated → Google sign-in → generate path → pricing → checkout (test card) → webhook unlocks paid features.

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
