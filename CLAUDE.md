@AGENTS.md

# CLAUDE.md

Project context and conventions for the Adaptive Learning Path app.

## Project

A Next.js + Vertex AI (Gemini) app that generates personalized, context-aware learning paths. Built for a 90-day competition with three hard constraints:

1. **Real customers + real revenue within 90 days** — Stripe is wired in early, not bolted on later.
2. **Operated by AI agents** — a curriculum agent autonomously sources, curates, sequences, and maintains paths.
3. **At least one Google Cloud product** — satisfied via Vertex AI (Gemini).

Original spec: `/Users/myozawwin/Downloads/learning-path-mvp-spec.md` (external to repo).

Full roadmap and phase plan: **[ROADMAP.md](docs/ROADMAP.md)**.

## Locked decisions

| Area               | Choice                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Niche              | Tech upskillers + students (math/science)                                                                                                                 |
| Launch topics      | Python for data/ML, JS+React, Calculus, Linear Algebra                                                                                                    |
| AI provider        | Vertex AI (Gemini) — uses GCP credits                                                                                                                     |
| DB + Auth          | Supabase (Postgres + Google OAuth)                                                                                                                        |
| Payments           | Stripe Checkout, single subscription, price TBD                                                                                                           |
| Styling            | Tailwind CSS                                                                                                                                              |
| Hosting            | **Google Cloud** — app on Cloud Run, worker on a GCE `e2-micro` (free-beta D1–D4). Vercel fully decommissioned 2026-07-31. See AGENTS.md for the topology.  |
| ORM                | Prisma over Supabase Postgres                                                                                                                             |
| Resource library   | Postgres `Resource` table (Prisma), agent-extensible                                                                                                      |
| Source attribution | Postgres `Source` table with hand-set `trustScore`; `Resource.trustScore` inherits from source at create                                                  |
| Path scope         | Single-topic by design. Multi-topic goal-driven plans compose Paths via a `Program` layer in Phase 2.75 (headline differentiator vs. course aggregators). |

## Coding conventions

- **Comments**: only where code can't speak for itself — non-obvious constraints, invariants, workarounds, "why" decisions. Never restate what a line does, narrate changes, or address the reviewer. Match the surrounding file's comment density.
- **Logging**: new server-side code logs via `log`/`logWarn`/`logError` from `@/lib/log` (one JSON object per line), never `console.*`. AI call sites report token usage with `recordUsage(stage, result.usage)`.
- **Validation at boundaries**: every API route input and every LLM structured output is parsed with a zod schema. Types derive from `z.infer<>` — never hand-write a duplicate interface next to a schema.
- **Layering**: route handlers stay thin (auth, parse, call, respond); business logic lives in `src/lib/` (services/agents/lib modules) where it's unit-testable without HTTP. UI derivation logic goes in `*-view-model.ts` / `*-view.ts` lib files, not inside components.
- **Server-first React**: components are Server Components by default; add `"use client"` only for interactivity, and keep client components at the leaves.
- **Env access**: read `process.env` only in leaf config modules (`lib/db`, `lib/ai/vertex`, `lib/supabase/*`, `lib/config`, auth helpers). Feature code imports from those; never inline `process.env.X` in a feature.
- **DB access**: Prisma via the `@/lib/db` singleton only. Raw SQL only in migrations, or where Prisma can't express it (pgvector) — with a comment saying so.
- **Errors**: no silent catches. Catch only where you can handle or translate; otherwise let it propagate. Any caught-and-continued error goes through `logError`.
- **Types**: `strict` is on; no `any`, no `as` casts or `!` assertions to silence the checker — fix the type. A justified exception gets a one-line comment.
- **New pure logic gets a colocated unit test** (`src/**/*.test.ts`). If it's hard to unit-test, that's a layering smell — extract the pure part.
- **Reference a doc by its filename, never its path.** Write `` `worker-deploy.md` ``, not `` `docs/worker-deploy.md` ``. Filenames under `docs/` are unique and stable; paths are not — moving the plan docs into `docs/plans/` broke twenty references in one commit. This covers code comments, error messages, prose in other docs, skills, and rules. Two exceptions: a **markdown link target** needs a working relative path (`[worker-deploy.md](worker-deploy.md)`) — name in the label, path in the target; and a path used as an **argument or a write target** (`git mv docs/plans/x.md docs/plans/archive/`, `--out=docs/audits/y.json`) is an operation, not a reference. `README.md` also keeps its path, since two of them exist. A bare name resolves via [docs/README.md](docs/README.md).

## Repo conventions

- Secrets live in `.env.local` (git-ignored); `.env.example` documents required keys.
- Never commit secrets, service-account JSON, or Stripe keys.
- **Commit messages: no `Co-Authored-By: Claude` trailer.** Write commit messages without the AI attribution footer.
- **Pull Requests: no `Generated with Claude Code` trailer** whenever opening new pull requests.
- Tracked under `.claude/`: shared skills (`.claude/skills/`), rules (`.claude/rules/`), agents (`.claude/agents/`), and `settings.json` — which is shared because its `deny` list is the only *enforced* half of `.claude/rules/env-files.md`. Everything else there stays git-ignored (`settings.local.json`, worktrees).

## Feature workflow

Features are planned in a dedicated planning conversation — the `/plan-feature` skill — which ends in a plan doc at `docs/plans/<feature>.md` with per-block briefs (blocks ≤300 LOC), then implemented block-by-block via the `/orchestrate-feature` skill, which spawns `block-implementer`, `block-verifier`, and `block-reviewer` subagents per block. Every block brief ends with an **Acceptance criteria** section: concrete, checkable assertions written at planning time (they drive the verifier; criteria written after implementation get bent to fit the code). Doc tiers, and where a shipped plan goes afterwards: [docs/README.md](docs/README.md) and [docs/plans/README.md](docs/plans/README.md). Two rules bind every conversation:

- **Verification gate**: nothing is committed until the user has manually verified the block. Commit/push/PR only after explicit confirmation.
- **JIT dependencies**: install a library only when the feature that needs it is being built — never up front.

Merging a stacked PR chain: use the `/merge-stacked-prs` skill — the ordering matters and has caused permanent PR-record damage before.

## Testing and styling

Detailed conventions live in `.claude/rules/` and load automatically when you touch matching files — `testing.md` (unit/integration split, `describeDb`, module-eval stubs) and `styling.md` (design tokens, dark mode). Read neighboring tests/components before writing new ones so the rules trigger.

Two testing facts with blast radius beyond test files:

- `npm test` = unit only, safe with no secrets; `npm run test:int` hits the real dev DB.
- **Before `npm run test:int`, stop the dockerized workers** (`docker compose --profile workers stop worker`) — they poll the same DB and steal the tests' queue rows. Restart afterwards with `docker compose --profile workers up -d --build` — without `--build` compose reuses a stale image indefinitely (see `.claude/rules/testing.md`).
