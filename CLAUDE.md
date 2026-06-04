@AGENTS.md

# CLAUDE.md

Project context and collaboration workflow for the Adaptive Learning Path app.

## Project

A Next.js + Vertex AI (Gemini) app that generates personalized, context-aware learning paths. Built for a 90-day competition with three hard constraints:

1. **Real customers + real revenue within 90 days** — Stripe is wired in early, not bolted on later.
2. **Operated by AI agents** — a curriculum agent autonomously sources, curates, sequences, and maintains paths.
3. **At least one Google Cloud product** — satisfied via Vertex AI (Gemini).

Original spec: `/Users/myozawwin/Downloads/learning-path-mvp-spec.md` (external to repo).

Full roadmap and phase plan: **[docs/ROADMAP.md](docs/ROADMAP.md)**.

## Locked decisions

| Area               | Choice                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Niche              | Tech upskillers + students (math/science)                                                                                                                 |
| Launch topics      | Python for data/ML, JS+React, Calculus, Linear Algebra                                                                                                    |
| AI provider        | Vertex AI (Gemini) — uses GCP credits                                                                                                                     |
| DB + Auth          | Supabase (Postgres + Google OAuth)                                                                                                                        |
| Payments           | Stripe Checkout, single subscription, price TBD                                                                                                           |
| Styling            | Tailwind CSS                                                                                                                                              |
| Hosting            | Vercel now, Cloud Run later                                                                                                                               |
| ORM                | Prisma over Supabase Postgres                                                                                                                             |
| Resource library   | Postgres `Resource` table (Prisma), agent-extensible                                                                                                      |
| Source attribution | Postgres `Source` table with hand-set `trustScore`; `Resource.trustScore` inherits from source at create                                                  |
| Path scope         | Single-topic by design. Multi-topic goal-driven plans compose Paths via a `Program` layer in Phase 2.75 (headline differentiator vs. course aggregators). |

## Workflow (read this before starting any feature)

Every feature in every phase follows this loop:

1. **One feature per conversation.** Start a fresh conversation for each feature.
2. **Discussion first.** Claude asks clarifying questions, offers insights, and surfaces criticisms before writing code. No code until consensus.
3. **Scope the feature.** Once aligned, Claude writes a scoped plan.
4. **Break into blocks of <300 LOC.** Smaller is better. Overruns rare and intentional.
5. **One branch per block.** Off `main`, or off the previous block's branch when stacking.
6. **Verification gate.** Claude provides a verification plan after each block; the user verifies manually before anything is committed.
7. **Commit + push + PR.** Only after the user confirms verification, Claude commits, pushes, and opens a PR.
8. **JIT dependencies.** Install libraries only when the feature that needs them is being built — never up front.

## Repo conventions

- Package manager: **npm** (locked by `package-lock.json`).
- App Router, TypeScript, `src/` directory, `@/*` import alias.
- Secrets live in `.env.local` (git-ignored); `.env.example` documents required keys.
- Never commit secrets, service-account JSON, or Stripe keys.
- **Commit messages: no `Co-Authored-By: Claude` trailer.** Write commit messages without the AI attribution footer.
- This file (CLAUDE.md) and shared skills under `.claude/skills/` are tracked; everything else under `.claude/` stays git-ignored (local settings, worktrees).
