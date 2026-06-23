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

### Merging a stacked PR chain into `main`

When a chain of PRs is stacked (each branch off the previous), merge **bottom-up, one block at a time**, and only ever retarget the *immediate next* PR — never the whole chain at once. For each PR, from the base of the stack upward:

1. Merge it into `main` (`gh pr merge <n> --merge`), but **do not pass `--delete-branch` yet**.
2. Retarget the immediate child (the PR based on this branch) to `main`: `gh pr edit <child> --base main`. Do this **while this branch still exists**.
3. Only now delete the just-merged branch: `git push origin --delete <branch>`.

Two failure modes this ordering prevents — both bit us merging the 2.5f stack (#85–#94):

- **Never blanket-retarget the whole chain to `main` up front.** A PR retargeted *before its parent merges* has its merge-base set to bare `main`, so its diff and commit list inflate to include every ancestor block's work. This is **permanent**: a merged PR's base branch is immutable, so the bloated "Files changed" / "Commits" record can't be fixed afterward. (`main`'s own history stays correct — only the PR record is wrong.)
- **Never `--delete-branch` a parent while a child PR still targets it.** Deleting a branch that is the base of an open PR *closes* that PR instead of retargeting it, and a closed PR whose base branch is gone can't be reopened without recreating the branch. Retarget the child to `main` (step 2) before deleting (step 3).

## Repo conventions

- Package manager: **npm** (locked by `package-lock.json`).
- App Router, TypeScript, `src/` directory, `@/*` import alias.
- Secrets live in `.env.local` (git-ignored); `.env.example` documents required keys.
- Never commit secrets, service-account JSON, or Stripe keys.
- **Commit messages: no `Co-Authored-By: Claude` trailer.** Write commit messages without the AI attribution footer.
- This file (CLAUDE.md) and shared skills under `.claude/skills/` are tracked; everything else under `.claude/` stays git-ignored (local settings, worktrees).

## Styling (Tailwind v4 — centralized design tokens)

Styling uses **Tailwind CSS v4**. The single source of truth for the visual language is **[`src/app/globals.css`](src/app/globals.css)**. The goal is that a global change — palette, type size, corner rounding, spacing — is **one edit there**, never a find-replace across components. Honor that when adding or changing UI.

**Where things live (all in `globals.css`):**

- **Colors** — `@theme` `--color-*` tokens (`brand`, `ink`, `ink-soft`, `body`, `muted`, `faint`, `faintest`, `line`, `line-soft`, `line-faint`, `surface`, `fill`, `fill-soft`, `track`, `hairline`, `success`, `success-bg`, …). Generates `text-*` / `bg-*` / `border-*` utilities.
- **Type scale** — `@theme` `--text-*` ramp (`text-2xs` … `text-3xl`). Applies app-wide (overrides a few Tailwind defaults; adds `2xs`/`md`).
- **Radii** — `@theme` semantic `--radius-*` tokens → `rounded-card` / `rounded-control` / `rounded-button`.
- **Layout constants** — `:root` vars, e.g. `--nav-h` (sticky nav height; sidebar/main heights derive from it via `calc()`), `--space-section` (vertical rhythm between cards).
- **Fonts** — IBM Plex is app-wide, wired in the **root layout** (`src/app/layout.tsx`) → use `font-sans` / `font-mono`.
- **Semantic component classes** — `@layer components` with `@apply`, for genuinely repeated multi-utility patterns: `.eyebrow` (uppercase mono micro-label), `.meta` / `.meta-xs` (mono meta text), `.card` (panel chrome), `.stat-value`.

**Rules for new/changed UI:**

1. **Use token utilities, never raw values.** `text-brand` not `text-[#3f6ad8]`; `text-sm` not `text-[15px]`; `rounded-card` not `rounded-[14px]`; `min-h-[calc(100vh-var(--nav-h))]` not `…-62px`. If you're typing a hex, a px font-size, or a radius literal, stop — use or add a token.
2. **Reuse the semantic classes** for the patterns they cover (eyebrow labels, meta text, cards) instead of re-listing their utilities. Need a per-instance tweak? Add an overriding utility (the `utilities` layer wins over `components`), e.g. `class="eyebrow text-brand"`.
3. **Promote to a token when a value repeats** (~2–3+ uses across components) or is a meaningful design constant. Add it to the right group in `globals.css`, then reference it everywhere.
4. **One-off decoratives may stay inline** — a single-use gradient, a lone max-width, a bespoke accent color. Keep it an arbitrary value and add a short comment if the intent isn't obvious. Don't over-abstract single uses into tokens.
5. **To restyle globally, edit `globals.css`** — bump a `--text-*` step for sizing, a `--color-*` for palette, `--radius-*` for rounding, `--nav-h`/`--space-section` for layout rhythm. Don't reintroduce per-component hardcoded values.

**Dark mode (OS preference).** The learn UI is dark-mode-aware via a `@media (prefers-color-scheme: dark)` block in `globals.css` that redefines the `--color-*` tokens (plus `--shadow-card` / `--gradient-thumb`) for dark. There are **no `dark:` variants in components** — utilities flip automatically because the tokens use plain `@theme` (var indirection), so overriding the CSS variable re-resolves every `text-*` / `bg-*` / `border-*`. To keep a new page dark-compatible:

- **Build with token utilities only** (rule 1). A token-clean component is dark-clean for free. The failure mode is hardcoded surfaces: `bg-white`, `text-[#…]`, inline `style={{ background: '#fff' }}` — these don't flip. Use **`bg-card`** for raised surfaces (nav/sidebar/panels — `.card` already does), `bg-surface` for the app background, and the text/line/fill tokens for everything else.
- **A color that must differ by theme but isn't a single `--color-*`** (a gradient, a theme-specific shadow) → make it a CSS variable in `:root` and override it in the dark block (see `--gradient-thumb`, `--shadow-card`), then reference `var(--…)`. Don't inline a light-only literal.
- **Adding a token?** Give it a dark value in the dark block too, or it'll be stuck at its light value in dark mode.
- ⚠️ **Never put `*/` inside a CSS comment** (e.g. writing `text-*/bg-*`) — it closes the comment early and crashes the Tailwind/PostCSS parse, after which the dev server silently serves stale CSS. Restart `next dev` after `@theme` changes if new tokens don't appear.

Scope note: the centralized system currently styles the **learn UI** (`src/app/learn/`); the internal `playground` pages predate it and still use ad-hoc utilities — fine to leave, but new shared surfaces should follow the rules above.
