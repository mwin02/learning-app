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
| Source as first-class entity | `Source` table with hand-set `trustScore` per publisher; `Resource.trustScore` inherits at create time | Gives the Phase 2 agent a reliability prior for newly-discovered resources before reviews exist — MDN's new article starts at 0.95, a random blog at 0.5 (decided during 1b.5) |

## Phase 1 — Foundation

Goal: a runnable Next.js scaffold + repo conventions + Vertex/Gemini proven end-to-end.

- [x] **Initialization** — `create-next-app`, `CLAUDE.md`, `docs/ROADMAP.md`, `.env.example`, initial commit on `main`
- [x] **Feature 1a — Vertex/Gemini hello-world.** `/api/health` route calls Gemini via Vertex; installs `ai` + `@ai-sdk/google-vertex`; GCP project + service account set up.
- [x] **Feature 1b — Seed library.** Postgres `Resource` table (Prisma 7) seeded with ~10 hand-curated entries per launch topic (39 total). Schema supports the Phase 2 growth loop: `slug`, `topic`, `title`, `url`, `type`, `tier`, `durationMin`, `summary`, `difficulty`, `prerequisiteConcepts[]`, `conceptsTaught[]`, `requiresPurchase`, `origin` (`seed`/`agent`/`user`, renamed from `source` in 1b.5), `status` (`active`/`deprecated`/`pending_review`). Curation rules in [`data/README.md`](../data/README.md). Originally scoped as a flat JSON; expanded to DB after discussion locked in "library-as-moat" (see Phase 2). PRs #2–#4.
- [x] **Feature 1b.5 — Source as a first-class entity.** New `Source` table represents the publisher/author/channel (MDN, 3Blue1Brown, MIT OCW, …) with a hand-set `trustScore` per the Gold/Strong/Solid rubric. `Resource.sourceId` is required; `Resource.trustScore` inherits from the source at create time and is updated by reviews from Phase 3 onward. 23 seeded sources cover all 39 resources. Old `ResourceSource` enum renamed to `Origin` so provenance and publisher attribution are no longer conflated. Adds `Resource.attribution` for byline credit when the publisher of trust differs from the named author (e.g. `"Mike Dane"` on a freeCodeCamp video). Per-review counter fields deferred to Phase 3 when `Review` lands. Rubric + add-resource workflow in [`data/README.md`](../data/README.md). PRs #6–#8.
- [ ] **Feature 1c — Vercel deploy.** Env vars wired in Vercel dashboard (Vertex creds + `DATABASE_URL` + `DIRECT_URL`); `/api/health` works in prod; production DB migrated + seeded.

**Exit criteria:** `/api/health` returns a Gemini-generated string in prod, AND the Resource library is migrated + seeded in the production Supabase database.

## Phase 2 — Path generation + library growth agent (spec §7)

- [ ] Prisma schema additions: `User(plan)`, `Path`, `PathItem(status, isCheckpoint, branchOnFail)`, `Progress`. (`Resource` table landed in Feature 1b.)
- [ ] `lib/curriculum-agent.ts` — input: `{topic, priorKnowledge, timeframe}`. **Library-first matching** against the `Resource` table (filters on topic, difficulty, prerequisite/taught concepts). **Trust-weighted ranking**: candidate resources are ordered using `trustScore` (inherited from `Source` at create time, updated by reviews later) so canonical publishers outrank obscure ones when other signals are equal. **Web-fallback** via Vertex grounding for topics the library doesn't cover well. **Cache-back**: vetted finds are upserted into `Resource` with `origin='agent'` and `status='pending_review'`; each is linked to a `Source` (existing if known, new with a default 0.5 trust prior otherwise) so the library compounds with use and the agent's next pass benefits from accumulated trust signals. Ranks/sequences via Gemini; returns ordered items with one-line `rationale`.
- [ ] Concept-tag normalization — bring agent-added tags into the seed vocabulary (embedding similarity or LLM canonicalization). Seed tags are free-text today; this is the first time matching cares.
- [ ] `app/api/generate-path/route.ts`
- [ ] Landing page `app/page.tsx` — dual-audience hero, form: topic dropdown (extensible beyond the 4 launch topics), prior knowledge, timeframe
- [ ] `app/path/[id]/page.tsx` — outline rendered (read-only)

**Exit criteria:** stranger fills form → sees a real sequenced path with per-item rationales. Requesting an off-library topic visibly grows the `Resource` table.

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
- Where the `Review` table lands (needs `User`, so earliest is Phase 3). Adds per-resource and per-source review counters; updates `Resource.trustScore` at full weight and `Source.trustScore` dampened by source resource count. Signal scale agreed in 1b.5: upvote+completed `+1.5`, upvote-only `+1.0`, downvote+completed `-1.0`, downvote+not-completed `-1.5`. `SourceTopicTrust` per-(source, topic) overrides may follow once the agent's library-first ranking shows uneven publisher quality across topics.
