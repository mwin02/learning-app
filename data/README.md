# `data/` — Resource library

The runtime resource library lives in Postgres (`Resource` table, see
`prisma/schema.prisma`). This directory holds the **seed source of truth** for
the four launch topics, plus the curation rules that govern what may enter the
library — whether added by hand, by the curriculum agent at runtime, or
(post-launch) by users.

## Files

- `seed-resources.ts` — typed array of resources loaded by `prisma/seed.ts` via
  `upsert(slug)`. Idempotent: re-running the seed updates existing rows rather
  than inserting duplicates.
- `README.md` — this file.

## How the library grows

1. **Seed (this directory).** Hand-curated resources for the four launch topics
   are committed here. `source: 'seed'`.
2. **Agent (Phase 2).** When a user requests a topic the library doesn't cover
   well, the curriculum agent searches the web, curates and reviews candidates,
   and writes new rows with `source: 'agent'`. Some may land as
   `status: 'pending_review'` for a human to confirm.
3. **User (post-launch).** Eventually, user-contributed resources land with
   `source: 'user'`. Same schema, same rules.

The schema commits to fields; values are best-effort. `difficulty` and
`prerequisiteConcepts` are hand-assigned at seed time without usage data to
validate them — the Phase 2 agent will refine matching over time.

## Schema (one row)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (cuid) | Auto. Don't set in seed input. |
| `slug` | `string` | **Stable, unique, human-readable.** Format: `{topic}-{short}`. Never rename — replace with a new row. |
| `topic` | `TopicSlug` | One of the four launch slugs (see `src/types/resource.ts`). |
| `title` | `string` | As shown on the resource. |
| `url` | `string` | Canonical, https, no tracking params. `@unique`. |
| `type` | `ResourceType` | `article \| video \| course \| interactive \| docs \| book` |
| `tier` | `ResourceTier` | `core` (in sequenceable pool) or `optional` (recommended only). |
| `durationMin` | `Int` | Total length. For courses: total course length. For books: estimated read time. |
| `summary` | `string` | 1–2 sentences, plain prose, no marketing language. |
| `difficulty` | `Difficulty` | `beginner \| intermediate \| advanced`. Three buckets — be honest. |
| `prerequisiteConcepts` | `string[]` | Concept tags the learner should know first. May be `[]`. |
| `conceptsTaught` | `string[]` | Concept tags this resource teaches. At least one. |
| `requiresPurchase` | `boolean` | `true` for books and paid recommendations. Implies `tier: 'optional'`. |
| `source` | `ResourceSource` | `seed` for hand-curated. Auto-defaults. |
| `status` | `ResourceStatus` | `active` by default. `deprecated` for dead links. `pending_review` for unvetted agent additions. |
| `language` | `string` | ISO 639-1. Defaults to `en`. |

## Curation rules

### Core tier — strict

A resource may be `tier: 'core'` only if **all** of:

- Free.
- English (or `language` set correctly).
- No login required to consume the content.
- Evergreen: at least 2 years old AND still maintained, OR official docs.
- Canonical URL (no `utm_*` or tracking params).
- `durationMin` is estimable from the resource itself.

### Optional tier — looser

A resource may be `tier: 'optional'` if it's exceptional but fails one of the
core rules:

- Books — always optional. Always `requiresPurchase: true` if not free.
- Paywalled-but-exceptional content (rare, used sparingly).
- Login-gated content from a reputable, free source.

Optional resources are recommended alongside paths, **never** inserted into the
core sequence.

### Excluded entirely

- Medium articles behind the metered paywall.
- Dead links (URL must currently 200).
- Login walls that block the content itself.
- Anything where payment is required to access the core idea (except books,
  which are explicitly optional).

## Concept tag conventions

Tags are free-text strings today; Phase 2 will normalize them. To keep matching
viable in the meantime:

- **Lowercase, hyphenated, noun phrases.** `list-comprehensions`, `derivatives`,
  `eigenvalues`, `gradient-descent`.
- **Topic-scoped when ambiguous.** `python-functions` vs `js-functions` if the
  concepts are meaningfully different. `derivatives` is fine unscoped — there's
  one calculus.
- **Granular enough to match, not so granular they never reuse.**
  `gradient-descent` ✅. `optimization` ❌ (too broad).
  `numpy-array-broadcasting` ✅. `broadcasting-when-shape-is-2x3` ❌.
- **Singular, not plural, when natural.** `derivative` is fine; `derivatives` is
  also fine — pick one per topic and stick to it. Check existing tags before
  adding a new one.

## Sources we draw from

freeCodeCamp, MDN, Python official docs, React official docs, 3Blue1Brown,
Khan Academy, MIT OpenCourseWare, Paul's Online Math Notes, Sentdex, Corey
Schafer, StatQuest (Josh Starmer), Real Python (free articles only).

## How to add a resource

1. Pick an `id`-free, unique `slug` in `{topic}-{short}` format.
2. Verify the URL loads without login in an incognito window.
3. Fill every required field. `prerequisiteConcepts` may be `[]`; `conceptsTaught`
   must have at least one tag.
4. Check existing concept tags in the same topic — reuse if the concept is the
   same; don't introduce `derivative` if `derivatives` already exists.
5. `npm run db:seed` (after Block 2 lands) — re-run is safe.
6. PR review: include URL, why it's in (or out of) core tier, and any new
   concept tags introduced.

## Tutor agent caveat for books

The Phase 4 tutor agent does **not** have full book content. When a user asks
about a `type: 'book'` resource, the agent must ask them to paste the relevant
passage. The agent reads `summary` only.
