---
paths:
  - "src/app/**/*.{tsx,css}"
  - "src/components/**/*.tsx"
---

# Styling (Tailwind v4 — centralized design tokens)

Styling uses **Tailwind CSS v4**. The single source of truth for the visual language is **`src/app/globals.css`**. The goal is that a global change — palette, type size, corner rounding, spacing — is **one edit there**, never a find-replace across components. Honor that when adding or changing UI.

## Where things live (all in `globals.css`)

- **Colors** — `@theme` `--color-*` tokens (`brand`, `ink`, `ink-soft`, `body`, `muted`, `faint`, `faintest`, `line`, `line-soft`, `line-faint`, `surface`, `fill`, `fill-soft`, `track`, `hairline`, `success`, `success-bg`, …). Generates `text-*` / `bg-*` / `border-*` utilities.
- **Type scale** — `@theme` `--text-*` ramp (`text-2xs` … `text-3xl`). Applies app-wide (overrides a few Tailwind defaults; adds `2xs`/`md`).
- **Radii** — `@theme` semantic `--radius-*` tokens → `rounded-card` / `rounded-control` / `rounded-button`.
- **Layout constants** — `:root` vars, e.g. `--nav-h` (sticky nav height; sidebar/main heights derive from it via `calc()`), `--space-section` (vertical rhythm between cards).
- **Fonts** — IBM Plex is app-wide, wired in the **root layout** (`src/app/layout.tsx`) → use `font-sans` / `font-mono`.
- **Semantic component classes** — `@layer components` with `@apply`, for genuinely repeated multi-utility patterns: `.eyebrow` (uppercase mono micro-label), `.meta` / `.meta-xs` (mono meta text), `.card` (panel chrome), `.stat-value`.

## Rules for new/changed UI

1. **Use token utilities, never raw values.** `text-brand` not `text-[#3f6ad8]`; `text-sm` not `text-[15px]`; `rounded-card` not `rounded-[14px]`; `min-h-[calc(100vh-var(--nav-h))]` not `…-62px`. If you're typing a hex, a px font-size, or a radius literal, stop — use or add a token.
2. **Reuse the semantic classes** for the patterns they cover (eyebrow labels, meta text, cards) instead of re-listing their utilities. Need a per-instance tweak? Add an overriding utility (the `utilities` layer wins over `components`), e.g. `class="eyebrow text-brand"`.
3. **Promote to a token when a value repeats** (~2–3+ uses across components) or is a meaningful design constant. Add it to the right group in `globals.css`, then reference it everywhere.
4. **One-off decoratives may stay inline** — a single-use gradient, a lone max-width, a bespoke accent color. Keep it an arbitrary value and add a short comment if the intent isn't obvious. Don't over-abstract single uses into tokens.
5. **To restyle globally, edit `globals.css`** — bump a `--text-*` step for sizing, a `--color-*` for palette, `--radius-*` for rounding, `--nav-h`/`--space-section` for layout rhythm. Don't reintroduce per-component hardcoded values.

## Dark mode (OS preference)

The learn UI is dark-mode-aware via a `@media (prefers-color-scheme: dark)` block in `globals.css` that redefines the `--color-*` tokens (plus `--shadow-card` / `--gradient-thumb`) for dark. There are **no `dark:` variants in components** — utilities flip automatically because the tokens use plain `@theme` (var indirection), so overriding the CSS variable re-resolves every `text-*` / `bg-*` / `border-*`. To keep a new page dark-compatible:

- **Build with token utilities only** (rule 1). A token-clean component is dark-clean for free. The failure mode is hardcoded surfaces: `bg-white`, `text-[#…]`, inline `style={{ background: '#fff' }}` — these don't flip. Use **`bg-card`** for raised surfaces (nav/sidebar/panels — `.card` already does), `bg-surface` for the app background, and the text/line/fill tokens for everything else.
- **A color that must differ by theme but isn't a single `--color-*`** (a gradient, a theme-specific shadow) → make it a CSS variable in `:root` and override it in the dark block (see `--gradient-thumb`, `--shadow-card`), then reference `var(--…)`. Don't inline a light-only literal.
- **Adding a token?** Give it a dark value in the dark block too, or it'll be stuck at its light value in dark mode.
- ⚠️ **Never put `*/` inside a CSS comment** (e.g. writing `text-*/bg-*`) — it closes the comment early and crashes the Tailwind/PostCSS parse, after which the dev server silently serves stale CSS. Restart `next dev` after `@theme` changes if new tokens don't appear.

Scope note: the centralized system currently styles the **learn UI** (`src/app/learn/`); the internal `playground` pages predate it and still use ad-hoc utilities — fine to leave, but new shared surfaces should follow the rules above.
