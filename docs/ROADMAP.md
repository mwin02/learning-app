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
| Web fallback | Vertex Gemini with grounded Google Search (single call, built-in citations). Not an agent-with-tools loop. |
| Topic dropdown | 4 seeded + **Machine Learning, Statistics, Go** = 7 options. The last three deliberately stress the web-fallback + cache-back loop. |
| Concept-tag normalization | LLM canonicalization at insert time. No embeddings/pgvector in Phase 2. |
| Phase-5 columns | `PathItem.isCheckpoint`, `PathItem.branchOnFail` get created in 2a but stay inert. |
| Path regeneration | Same input = fresh path each time. No caching. |
| Model selection | Central agent → model registry at `src/lib/models.ts`. Each agent has a default `{ modelId, temperature, maxTokens }`, overridable by env var (e.g. `MODEL_CURRICULUM=…`). Phase 2 wires Gemini 2.5 Flash everywhere; abstraction ships so model swaps are config, not refactor. |
| Billing modeling | Separate `Subscription` table from day 1 (scaffold in 2a, populated in Phase 3), not a `plan` column on `User`. Acknowledges billing belongs in its own aggregate; avoids a schema migration when Stripe lands. |
| Generation inputs storage | `Path.inputPriorKnowledge`, `Path.inputTimeframeWeeks`, `Path.inputHoursPerWeek` live on `Path`, not `EnrolledPath`. These shape *what content* the agent picks (not just pacing), so storing on `Path` keeps the artifact reproducible and per-item rationale auditable. Trade-off: less Path reuse across users with similar inputs; acceptable because "no caching" is locked and dedup belongs at the agent layer if it ever matters. |

### Block sequence (each <300 LOC, one PR per block)

- [x] **2a — Prisma schema additions.** `User` (minimal), `Subscription` (scaffold), `Path(createdBy nullable FK, input* snapshot)`, `PathItem(status, isCheckpoint, branchOnFail)`, `EnrolledPath`, `Progress`. (`Resource` table landed in Feature 1b.) PR #14.
- [ ] **2b — Curriculum agent (library-first) + model registry.** `src/lib/models.ts` + `src/lib/curriculum-agent.ts` doing library-first matching against `Resource` (filters on topic, difficulty, prerequisite/taught concepts), Gemini sequencing + per-item `rationale`. Refactor `/api/health` onto the registry. No web fallback, no DB writes yet. Driven via throwaway `scripts/try-agent.ts`.
- [ ] **2c — Web fallback + cache-back + tag canonicalization.** Vertex-grounded Google Search when topic ∉ seeded set or library candidates < threshold. LLM tag canonicalization against existing topic vocab. Upsert finds as `Resource(origin='agent', status='pending_review')`. Per-topic ≥10 active gate.
- [ ] **2d — `POST /api/generate-path` route.** Thin wrapper: validates body → calls agent → creates `Path` + `PathItem` rows in a single transaction.
- [ ] **2e — Landing page `app/page.tsx`.** Dual-audience hero, form (7-topic dropdown, prior knowledge, timeframe), submit → redirect to `/path/[id]`.
- [ ] **2f — `app/path/[id]/page.tsx`.** Read-only outline with per-item rationale.

**Exit criteria:** stranger fills form → sees a real sequenced path with per-item rationales. Requesting an off-library topic (Go / ML / Statistics) visibly grows the `Resource` table. Re-running the same off-library topic reuses cached agent-found resources.

## Phase 2.5 — Content-generating agent

Sits between Phase 2 and Phase 3. Not the headline feature, but a real differentiator: while learners walk through a path, selected items get **agent-generated exercises and Jupyter notebooks** attached, so the path isn't just a curated link list.

- [ ] **2.5a — `Exercise` schema + migration; storage bucket provisioned.** `Exercise(resourceId, pathItemId?, prompt, answer, rubric, kind, origin)`. Storage backend TBD between Supabase Storage and Google Cloud Storage (GCS adds a 2nd GCP product and uses credits — decide at phase start).
- [ ] **2.5b — `lib/content-agent.ts`.** Generates `Exercise` records (text/MCQ first; cheapest, fastest).
- [ ] **2.5c — Notebook generation.** Agent emits `.ipynb` JSON via Gemini, uploaded to storage, registered as a `Resource(type='interactive', origin='agent', status='pending_review')` with a Colab deeplink.
- [ ] **2.5d — Wire curriculum-agent → content-agent inside `/api/generate-path`.** Curriculum agent decides *which* items deserve generated content (gap-driven), then fans out in parallel.
- [ ] **2.5e — `/path/[id]` UI updates.** Render exercises inline; notebook items show "Open in Colab".

**Exit criteria:** generating a path on an off-library topic produces at least one auto-generated exercise and one auto-generated notebook, both linked from `/path/[id]`.

### Open items for Phase 2.5

- Storage backend: Supabase Storage vs Google Cloud Storage.
- How to grade exercises (reveal-only in 2.5, or wait for Phase 4 tutor to grade?).
- Cost ceiling per `generate-path` request — may need to cap generated content to N items per path.

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
