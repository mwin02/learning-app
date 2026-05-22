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

## Phase 1 — Foundation

Goal: a runnable Next.js scaffold + repo conventions + Vertex/Gemini proven end-to-end.

- [x] **Initialization** — `create-next-app`, `CLAUDE.md`, `docs/ROADMAP.md`, `.env.example`, initial commit on `main`
- [ ] **Feature 1a — Vertex/Gemini hello-world.** `/api/health` route calls Gemini via Vertex; installs `ai` + `@ai-sdk/google-vertex`; GCP project + service account set up; verify model strings against current AI SDK docs (don't trust memory)
- [ ] **Feature 1b — Seed data.** `data/resources.json` with 8–12 hand-picked items per launch topic, shape `{id, topic, title, url, type, durationMin, summary}`
- [ ] **Feature 1c — Vercel deploy.** Env vars wired in Vercel dashboard; `/api/health` works in prod

**Exit criteria:** `curl https://<app>.vercel.app/api/health` returns a Gemini-generated string.

## Phase 2 — Path generation agent (spec §7)

- [ ] Prisma schema: `User(plan)`, `Path`, `PathItem(status, isCheckpoint, branchOnFail)`, `Progress`
- [ ] `lib/curriculum-agent.ts` — input: `{topic, priorKnowledge, timeframe}`; ranks/sequences/justifies via Gemini; returns ordered items with one-line `rationale`
- [ ] `app/api/generate-path/route.ts`
- [ ] Landing page `app/page.tsx` — dual-audience hero, form: topic dropdown, prior knowledge, timeframe
- [ ] `app/path/[id]/page.tsx` — outline rendered (read-only)

**Exit criteria:** stranger fills form → sees a real sequenced path with per-item rationales.

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
