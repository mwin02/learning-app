# `data/` — Resource library

The runtime resource library lives in Postgres (`Resource` and `Source` tables,
see `prisma/schema.prisma`). This directory holds the **seed source of truth**
for the four launch topics, plus the curation rules that govern what may enter
the library — whether added by hand, by the curriculum agent at runtime, or
(post-launch) by users.

## Files

- `seed-resources.ts` — typed array of resources loaded by `prisma/seed.ts` via
  `upsert(slug)`. Idempotent: re-running the seed updates existing rows rather
  than inserting duplicates.
- `seed-sources.ts` — typed array of publishers (MDN, 3Blue1Brown, MIT OCW, …)
  with hand-set trust scores. Seeded before resources; each resource resolves
  its `sourceSlug` to a `sourceId` at seed time.
- `README.md` — this file.

## How the library grows

1. **Seed (this directory).** Hand-curated sources and resources for the four
   launch topics are committed here. `origin: 'seed'`.
2. **Agent (Phase 2).** When a user requests a topic the library doesn't cover
   well, the curriculum agent searches the web, curates and reviews candidates,
   and writes new rows with `origin: 'agent'`. Some may land as
   `status: 'pending_review'` for a human to confirm.
3. **User (post-launch).** Eventually, user-contributed resources land with
   `origin: 'user'`. Same schema, same rules.

The `origin` enum tracks **how a row got into the DB**, not who published it —
publisher attribution is the `Source` relation, which is set independently of
origin.

The schema commits to fields; values are best-effort. `difficulty` and
`prerequisiteConcepts` are hand-assigned at seed time without usage data to
validate them — the Phase 2 agent will refine matching over time.

## Resource schema (one row)

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
| `sourceId` | `string` | FK to `Source`. Set via `sourceSlug` in seed input; the seed script resolves it. |
| `attribution` | `string?` | Optional byline credit when the publisher of trust differs from the named author(s) — e.g. `"Mike Dane"` on a freeCodeCamp video. Leave null if the source name is sufficient. |
| `trustScore` | `Float` | Inherits from `source.trustScore` at create time. Updated by reviews in Phase 3+. Curators don't set it manually. |
| `origin` | `Origin` | `seed` for hand-curated. Auto-defaults. |
| `status` | `ResourceStatus` | `active` by default. `deprecated` for dead links. `pending_review` for unvetted agent additions. |
| `language` | `string` | ISO 639-1. Defaults to `en`. |

## Source schema (one row)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (cuid) | Auto. |
| `slug` | `string` | **Stable, unique.** Short kebab-case. Referenced by `Resource.sourceSlug`. |
| `name` | `string` | Display name. May include parenthetical author for personal channels. |
| `url` | `string` | Publisher homepage (or work landing page for multi-author books). Not unique — two sources may share a domain in edge cases. |
| `kind` | `SourceKind` | `official_docs \| educator \| course_platform \| textbook \| community` |
| `trustScore` | `Float` | Hand-set at seed time per the rubric below. Updated by reviews in Phase 3+. |

## Trust score rubric

| Tier | Score | Use for |
|---|---|---|
| **Gold** | `0.95` | Canonical publishers with decades of trust: MDN, official language/library docs, 3Blue1Brown, MIT OCW, Khan Academy, OpenStax, widely-cited academic texts (Axler, Strang). |
| **Strong** | `0.85` | Well-regarded across the community but narrower scope: smaller official docs (NumPy/Pandas/etc.), individual educators with strong track records (Corey Schafer, StatQuest, Paul's Notes), modern reference sites (javascript.info), broad nonprofits (freeCodeCamp), respected newer texts (MML). |
| **Solid** | `0.70` | Good resources with a single work, niche audience, or shorter track record (Professor Leonard, Eloquent JS, Immersive Math, Automate the Boring Stuff). |
| **Unknown** | `0.50` | Default for any source we have no prior on. The Phase 2 agent uses this for newly-discovered publishers until reviews accumulate. |

**Source kind decisions:**

- **Platform > individual contributor.** When an educator publishes via a vetted
  platform (freeCodeCamp's YouTube channel, MIT OCW), the *platform* is the
  source — it bears the trust signal. Individual contributor goes in
  `Resource.attribution` if material. Only attribute to the individual when
  they are the sole contributor (3Blue1Brown, Corey Schafer).
- **Multi-author works are atomic.** A book by multiple authors (MML, Axler,
  Immersive Math) is its own source, independent of each author. No author
  trust inheritance.

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

## How to add a resource

### From an existing source

1. Pick an `id`-free, unique `slug` in `{topic}-{short}` format.
2. Verify the URL loads without login in an incognito window.
3. Set `sourceSlug` to the source's slug from `seed-sources.ts`.
4. Fill every required field. `prerequisiteConcepts` may be `[]`;
   `conceptsTaught` must have at least one tag.
5. Check existing concept tags in the same topic — reuse if the concept is the
   same; don't introduce `derivative` if `derivatives` already exists.
6. `npm run db:seed` — re-run is safe and idempotent.
7. PR review: include URL, why it's in (or out of) core tier, and any new
   concept tags introduced.

### From a new publisher

Add the source to `seed-sources.ts` first:

1. Pick a short kebab-case `slug`. Avoid topic prefixes — sources are
   topic-agnostic.
2. Set `kind` per the categories above.
3. Set `trustScore` from the rubric. Lean conservative: 0.85 is the right
   default for a publisher you'd recommend without hesitation but who isn't
   universally known. Reserve 0.95 for the canonical few.
4. Then add the resource as above, with `sourceSlug` pointing at the new entry.

## Tutor agent caveat for books

The Phase 4 tutor agent does **not** have full book content. When a user asks
about a `type: 'book'` resource, the agent must ask them to paste the relevant
passage. The agent reads `summary` only.
