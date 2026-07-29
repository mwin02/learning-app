# Free-Beta Plan — ratings, GCP migration, observability, warm paths

**Decided 2026-07-18.** The next milestone is a **free public beta**, displacing Stripe as
NEXT UP (Stripe + audit Block 5 move to post-beta; see [ROADMAP](ROADMAP.md)). This doc is
the source of truth for the beta work: every block below is meant to be workable by a
**fresh conversation** with no other context — it records the design decisions already
locked, the codebase facts the decisions rest on, and the ambiguities deliberately left
open (marked **OPEN** — settle them in the block's discussion phase, not unilaterally).

Workflow per CLAUDE.md applies to every block: one feature per conversation, discussion
first, <300 LOC per block, one branch per block, verification gate before commit/PR.

## Sequencing

| # | Block | Kind | Depends on |
| --- | --- | --- | --- |
| A1 | Ratings: schema + vote signal + trust recompute | code | — |
| A2 | Ratings: vote API + learn-UI thumbs | code | A1 |
| A3 | Ratings: trust into track build | code | A1 (conceptually; independent code) |
| A4 | Ratings: automatic low-trust eviction | code | A1 |
| D1 | GCP: app Dockerfile + local container verify | code | — |
| D2 | GCP: schema deploy + library data migration to Supabase | code + ops | — |
| D3 | GCP: Cloud Run app service live, Vercel decommissioned | ops | D1, D2 |
| D4 | GCP: Cloud Run worker pools live | ops | D2, D3 |
| B1 | Observability: GCP-native error reporting | code + ops | D3 (verified on Cloud Run) |
| C1 | Warm campaign: `reset-maps` + `warm-paths` scripts | code | — |
| C2 | Warm campaign: rebuild the 12 warm topics + review passes | ops | A*, D4, C1, **topic-filing T4** |

Rationale for the order: ratings are platform-independent code and should be live before
beta users arrive; the migration lands **before** the warm campaign so beta traffic and the
warm builds both run on the final architecture (C2 doubles as the cloud workers' shakedown);
observability is verified against Cloud Run, so it follows D3.

A-blocks stack off each other (branch per block, stacked PRs — merge bottom-up per the
CLAUDE.md stacked-chain procedure). D/B/C blocks are independent branches off `main`.

## Locked decisions (this plan)

| Area | Decision |
| --- | --- |
| Beta pricing | Free — no Stripe, no paid gate. Existing free-tier quota (`programQuota` / burst limits in `src/lib/services/program-limits.ts`) is the only metering. |
| Ratings granularity | **Resource-global** likes/dislikes (one vote per user per resource, ±1, changeable/clearable). A dislike means "bad resource", not "bad fit for this concept" — per-concept fit stays the judge's `coverageScore`. Eviction therefore removes the resource from **all** concepts it's attached to. |
| Ratings → trust | Votes are one more `EvidenceSignal` into `computeTrustScore` (`src/lib/curation/trust-score.ts` was designed for exactly this — see its header). Raw votes persist so trust stays recomputable. |
| Trust in track builds | Persisted candidates get re-ranked with the same coverage+trust blend used at attach time. **Invariant preserved: coverage gates, trust only orders** — trust never admits, never evicts (eviction is A4's explicit threshold, not ranking). |
| Eviction | **Automatic threshold** (low trust + enough votes), executed by **reusing `applyPendingReview` reject (soft)** — no new removal machinery. Operator **restore** is future work: design must keep it easy (restore = flip `active` + re-judge; see A4), but do not build it now. |
| Existing paths | **Recreated, not patched** — they were authored under different pipeline versions and are inconsistent. Wipe the map/track layer, keep the library, rebuild via the warm campaign. |
| Warm topic set | 12 topics (see C2): the 8 existing curated topics minus `go` (off-niche; stays available on demand), plus `sql`, `data-structures-algorithms`, `precalculus`, `physics-mechanics`. |
| Hosting | **Full compute migration to GCP**: Next.js app on a Cloud Run service, workers on Cloud Run worker pools. Vercel decommissioned. |
| DB + auth | **Supabase stays** (locked in CLAUDE.md; re-confirmed 2026-07-18). "Fully Google Cloud" means compute only. |
| Domain | User is acquiring a custom domain; D3 includes domain mapping + the Supabase OAuth redirect cutover. |
| Data migration | The **library layer only** (`Source`, `TopicAlias`, `Resource`) moves from the local dev DB to Supabase, via a Node script (no `pg_dump` in this environment). Embeddings are **not** copied — re-run the embed backfill on Supabase. Map/track/program layers are NOT migrated (warm campaign rebuilds them). Local `User`/`Progress` rows are dev-only and stay behind. |
| Error reporting | **GCP-native** (Cloud Logging auto-ingest of stdout JSON + Error Reporting + a Monitoring alert policy). Sentry rejected: its host-agnosticism advantage is moot post-migration, and GCP-native is zero-dep and burns credits. Client-side errors reach the same stream via a small report endpoint. |

## Codebase facts the plan rests on (verified 2026-07-18)

Fresh conversations: trust these, but re-verify line numbers before editing.

1. **Rejection already propagates to concept maps.** `applyPendingReview` reject
   (`src/lib/curation/pending-review.ts`, shipped 2.5g-5) deprecates the resource(s),
   **deletes their `ConceptResource` links from every Path**, marks affected concept banks
   stale (`markBankStale`), and recomputes each Path's readiness — one transaction. A
   reopened spine hole regresses the Path to `building`; remediation refills it. Built
   Tracks are immutable and untouched (by design). **No post-review hook is needed** — an
   early assumption to the contrary was wrong.
2. **The trust seam anticipates votes.** `computeTrustScore({ base, signals })` is a
   precision-weighted blend of a Source prior and `EvidenceSignal[]` terms; the YouTube
   engagement signal (`src/lib/curation/youtube-signal.ts`) is the existing example. Raw
   engagement columns on `Resource` (`viewCount`, `likeCount`, `youtubeChannelId`) exist so
   trust is recomputable when new evidence lands. Knobs: `TRUST_PRIOR_STRENGTH` (1),
   `TRUST_FLOOR` (0.1 — a clamp, not a gate), `TRUST_SELECTION_WEIGHT` (0.3) in
   `src/lib/config.ts`.
3. **Trust currently has zero effect on tracks built from existing paths.** Trust ranks
   only *freshly judged* candidates (`selectionScore` in
   `src/lib/agents/map/attach-candidates.ts`). At track build, `loadComposerMap`
   (`src/lib/agents/track/build-track.ts`) loads persisted `ConceptResource` rows ordered
   by `coverageScore` **only** — `trustScore` is not even selected — and both composers +
   `validate-composition.ts` pick primaries by coverage alone. Closing this gap is A3.
4. **Tooling constraints:** no `psql`/`pg_dump` CLIs in this environment (see
   `scripts/reset-content.ts` header + project memory); DB scripts run as
   `npx tsx --env-file=.env.local scripts/<x>.ts`. The `embedding` column is
   Prisma-`Unsupported` pgvector, written only via raw SQL in `src/lib/embeddings.ts`.
5. **`ResourceSourcedFor` is Concept-anchored** (FK → `Concept`, `onDelete: Cascade`), so
   it dies with the map wipe and does **not** migrate; warm builds regenerate provenance.
   Its existence is what makes the future eviction-restore cheap *going forward* (restore =
   flip status + re-judge against sourced-for concepts via `judgeAndAttachCandidates`).
6. **Existing ops assets:** `scripts/prewarm.ts` (drive one topic through
   `ensurePathMap` + `remediatePath`), `scripts/reset-content.ts` (wipes content INCLUDING
   the library — too blunt for C1; snapshots to `backups/` first), `scripts/remediate.ts`,
   `scripts/embed-resources.ts` (re-embed backfill), `docs/worker-deploy.md` (complete
   Cloud Run worker-pool runbook, verified 2026-07-13), `Dockerfile.worker`,
   `next.config.ts` already sets `output: 'standalone'`. Review skills:
   `/decompose`, `/review-pending-resources` (browser-graded rubric + API execution).
7. **Structured logging exists** (`src/lib/log.ts`, H3): one JSON object per line to
   stdout/stderr with `ts`/`level`/`event`/`traceId`, plus AsyncLocalStorage usage
   accounting persisted per job. B1 builds on this, it does not replace it.
8. **Hand-written indexes** (`Resource_embedding_idx` hnsw, `RemediationJob_active_per_path`
   partial unique) live only in migration SQL — every new migration must be checked for
   auto-generated `DROP INDEX` lines (AGENTS.md), and D2 must verify both exist on Supabase
   after `migrate deploy`.

---

## Feature A — resource ratings

### A1 — schema + vote signal + trust recompute (~120 LOC)

**Schema:** new `ResourceRating` model:

```prisma
model ResourceRating {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  resourceId String
  resource   Resource @relation(fields: [resourceId], references: [id], onDelete: Cascade)
  value      Int      // +1 like, -1 dislike
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([userId, resourceId])
  @@index([resourceId])
}
```

Check the generated migration for spurious `DROP INDEX` lines (fact 8).

**Pure signal function** (colocated unit tests, no DB): `voteSignal(likes, dislikes):
EvidenceSignal | null` in `src/lib/curation/vote-signal.ts`, mirroring
`youtube-signal.ts`'s shape: `value` = smoothed like-share (Laplace/Beta smoothing so 1
like ≠ certainty), `confidence` grows with total vote count, `weight` = new
`TRUST_VOTES_WEIGHT` config knob. Null (or zero-precision) below a minimum vote count.

**Recompute seam:** a `recomputeResourceTrust(resourceId)` helper that loads the Source
prior + existing YouTube stats + vote counts, rebuilds the full signal list
(`[youtubeSignal?, voteSignal?]`), and persists `Resource.trustScore =
computeTrustScore(...)`. Called from the vote route (A2) after each vote write. Keep it a
lib function so a backfill/script can batch-call it later.

**OPEN (settle in A1 discussion):**
- Smoothing constants + confidence curve + `TRUST_VOTES_WEIGHT` value (YouTube's weight is
  the calibration reference — read `youtube-signal.ts` + its config block first).
- Whether the YouTube engagement signal must be *re-derivable* at recompute time from the
  persisted `viewCount`/`likeCount` (it should be — verify the exact function used at
  upsert time in `src/lib/agents/decomposition/upsert-resource.ts` is reusable as-is).
- Whether `origin='generated'` resources (on-ramp lessons) accept votes at all (they have
  no external Source reputation and A4 eviction of a generated primary is nonsensical —
  lean: votable for signal, excluded from eviction; decide in A4 if deferred here).

### A2 — vote API + learn-UI thumbs (~150 LOC)

- Route (e.g. `POST /api/resources/[id]/rating` with `{ value: 1 | -1 | null }`, null =
  clear) wrapped in `withAuth` (CSRF/origin check comes free per H2), upserting/deleting
  the `ResourceRating` row then calling `recomputeResourceTrust`. Non-enumerable 404 for
  unknown/unratable ids.
- UI: thumbs up/down in the lesson view's resource pane
  (`src/app/learn/` + program-scoped course-player routes; `ResourcePane` is the anchor).
  Token-styled per CLAUDE.md § Styling (no raw hex/px; dark-mode-clean by construction),
  optimistic toggle, reflects the user's current vote on load.
- The viewer's own vote must be loadable wherever the lesson view assembles its data
  (`getTrackView` / lesson view-model — find the loader, don't add a client fetch per
  resource if the server loader can join it).

**OPEN:** whether aggregate counts are shown to learners or the UI stays two plain toggle
buttons (lean: plain toggles for beta — showing counts invites herding and looks bad at
n=2); exact placement (per-resource in the pane vs. per-lesson footer).

### A3 — trust into track builds (~80 LOC)

- `loadComposerMap` (`build-track.ts`): select `trustScore` (+ `durationMin` if not
  already) on the resource, and order/rank candidates by the attach-time blend instead of
  raw coverage. Reuse `selectionScore`/`capCandidates` exports from
  `attach-candidates.ts` rather than duplicating the formula — export what's missing.
- Audit every consumer that assumes coverage-desc ordering: `composer.ts`,
  `composer-agent.ts` (its own `.sort((a,b) => b.coverageScore - a.coverageScore)`),
  `validate-composition.ts` primary pick. Both composer modes must rank identically
  (`TRACK_COMPOSER_MODE` — the agent mode exists behind a flag).
- **Invariant (locked):** coverage still gates primaries
  (`MAP_SPINE_MIN_PRIMARY_COVERAGE` is a coverage check, never blended) — trust only
  orders. Unit tests pin this: equal-coverage candidates order by trust; a sub-floor
  high-trust candidate never becomes primary.

**OPEN:** whether the re-rank happens inside `loadComposerMap` (one seam, both composers
inherit) or in each consumer; whether `add-frontier-concept.ts` / `remediate-path.ts`
re-cap paths (they use `capCandidates`, which already blends when trust is carried) need
`trustScore` threaded into their DB loads too — grep `loadAsSearchResults` and the re-cap
call sites in `source-concept.ts` (line ~176: selects `coverageScore` only).

### A4 — automatic low-trust eviction (~100 LOC)

- New config: `TRUST_EVICT_FLOOR`, `TRUST_EVICT_MIN_VOTES`. Both must respect existing
  bounds: `TRUST_FLOOR` (0.1) is the recompute clamp, so `TRUST_EVICT_FLOOR` must sit
  above it or eviction can never fire; the min-votes bar is what makes a drive-by pair of
  dislikes harmless.
- Trigger: inside/after `recomputeResourceTrust` (vote-time only — no cron). When
  `trustScore < TRUST_EVICT_FLOOR && totalVotes >= TRUST_EVICT_MIN_VOTES` and the
  resource is `active`, execute **`applyPendingReview({ action: 'reject', severity:
  'soft', cascade: false })`** — this reuses, for free: deprecation +
  `deprecationSeverity`, ConceptResource link deletion across all Paths, bank staleness,
  readiness recompute (and remediation refills any reopened hole). Log a structured
  event (`resource.trust-evicted`) with resourceId, score, vote counts.
- **Restore path (design-only, do not build):** an evicted row keeps its `ResourceRating`
  rows and stats; restore later = set `status='active'` + clear `deprecationSeverity` +
  re-judge via `judgeAndAttachCandidates` against its current sourced-for/topic concepts.
  Nothing in A4 may make that harder (e.g. don't delete votes on eviction).
- Guard rails: idempotent (already-deprecated rows skip); exclude `origin='generated'`
  rows (see A1 OPEN); eviction of a resource that is some concept's only candidate is
  *allowed* (that's what remediation is for) but worth logging loudly.

**OPEN:** threshold values (pick after A1's signal shape is fixed — work an example: at
`TRUST_VOTES_WEIGHT` w and prior p, how many net dislikes drag a 0.8-prior resource under
the floor?); whether the reject call happens sync in the vote request or is deferred
(lean: sync — it's one transaction and rare).

---

## Feature D — GCP migration (compute to Cloud Run, library data to Supabase)

### D1 — app Dockerfile + local container verify (~60 LOC)

- `Dockerfile` for the Next.js app off `output: 'standalone'` (already set in
  `next.config.ts`): build stage (`npm ci` + `npm run build` + `prisma generate`), slim
  runtime stage copying `.next/standalone` + `.next/static` + `public`. Mirror
  `Dockerfile.worker`'s conventions (base image, non-root user if it has one).
- Verify by running the container locally against `.env.local` (app boots, a page
  renders, an API route answers). No cloud resources touched.
- Draft `docs/app-deploy.md` skeleton alongside (filled during D3), companion to
  `docs/worker-deploy.md`.

**OPEN:** whether the app image needs Prisma engine binaries for the target platform
(standalone output usually bundles them — verify `linux-musl` vs `debian` engine matches
the base image); Apple-Silicon cross-build noted in worker-deploy.md applies here too
(prefer Cloud Build).

### D2 — Supabase schema deploy + library migration (~150 LOC script + ops)

> **As-built corrections (measured 2026-07-29; script merged as #283 and the
> copy since executed — Supabase holds 26 `Source` / 36 `TopicAlias` / 2,008
> `Resource` / 2,405 `ResourceTopic`, all embedded, 23 `TopicCentroid`).** Three
> of the premises below changed:
>
> 1. **Step 1 is already done.** Supabase is at **36/36 migrations** (through
>    topic-filing T2a, including A1's `resource_rating`), both hand-written
>    indexes exist, and the `vector` extension is enabled. `vercel.json`'s
>    `buildCommand` (`prisma migrate deploy && next build`) is what has been
>    keeping it current — **D3 must replace that or the schema silently stops
>    tracking `main`.** Step 1 is now verification, not deployment.
> 2. **Supabase is completely empty** — 0 rows in *every* table, `User`
>    included. The "already backs the live Vercel deploy (real `User` rows)"
>    gotcha below is false: there is nothing to conflict with, local-wins is
>    trivially satisfied, and D3's OAuth cutover breaks no live sessions.
> 3. **`ResourceTopic` must be copied** (2,405 rows). The table list below
>    predates topic filing T1; membership now lives there and retrieval's
>    `topic IN (…)` EXISTS subquery reads it, so copying `Resource` without it
>    yields a library no query can reach. `TopicCentroid` is correctly excluded
>    — pgvector, and `embed-resources.ts` regenerates it via
>    `refreshTopicCentroids()`.
>
> Volumes are ~4× the estimate: `Source` 26, `TopicAlias` 36, **`Resource`
> 2,008** (1,389 with a parent), `ResourceTopic` 2,405. The step-3 re-embed is a
> full 2,008-row cold run, not ~500.
>
> OPENs settled: target lands in a new **`SUPABASE_DB_URL`** (direct 5432),
> separate from `DATABASE_URL` so the direction can't be reversed; conflict
> policy is local-wins, implemented as **id preservation** + upsert-by-PK, with
> a preflight that aborts if the target holds a natural key under a different
> id.

Order of operations:

1. `prisma migrate deploy` against the Supabase DB (needs its connection string —
   direct/session connection, not the pooled URL, for DDL). Then verify the two
   hand-written indexes exist (fact 8): `SELECT indexname FROM pg_indexes WHERE indexname
   IN ('Resource_embedding_idx', 'RemediationJob_active_per_path');` and that the
   `vector` extension is enabled.
2. `scripts/migrate-library.ts` — Node/tsx, **two Prisma clients** (local `DATABASE_URL`
   source → `SUPABASE_DB_URL` target). Copies, in order: `Source` (upsert by `slug`),
   `TopicAlias` (upsert by `alias`), `Resource` (upsert by natural key; parents before
   children — sort by tree depth or iterate until no orphans — so `parentResourceId` FKs
   resolve). **Skip the `embedding` column entirely; leave `embeddedAt` null.** Do NOT
   copy: Path/Concept/Track/Program layers (rebuilt by C2), `ResourceSourcedFor` (fact
   5), local `User`/`Progress`/ratings.
3. Re-embed on Supabase: run `scripts/embed-resources.ts` pointed at the Supabase URL
   (~500 rows, `embedMany` batches, minutes).
4. Verify: per-table row counts, per-topic resource counts vs. local, one decomposition
   tree spot-checked (parent links + `orderInParent` intact), a `searchResources` smoke
   query returning sane semantic hits.

Gotchas: the prod Supabase DB already backs the live Vercel deploy (real `User` rows +
whatever early rows exist) — the script must be **idempotent and additive** (upserts, no
truncates, never touches `User`). Supabase poolers (pgbouncer) can break long
transactions — use the direct connection for the copy. `Resource`'s natural key: `url` is
the practical dedup key (see how discovery dedups) — confirm `slug` vs `url` uniqueness
semantics in schema before choosing.

**OPEN:** which Supabase connection string variant lands in which env var (align with
what `src/lib/db.ts` expects in prod); whether the migration runs against a paused/quiet
window (no workers yet, so probably irrelevant); whether existing prod rows (if any
Resources exist from the live deploy) win conflicts or local wins (lean: local wins — the
local library is the curated, backfilled, reviewed one).

### D3 — Cloud Run app service live (ops; runbook into `docs/app-deploy.md`)

> **DONE 2026-07-29, except the deferred domain half.** The service is live at
> `https://learning-app-74223797331.us-west1.run.app` and verified: SSR, DB
> probe, Google sign-in round-trip, program creation 202 (which proves ADC →
> Vertex in-cloud), admin gate 404, structured logs in Cloud Logging.
> `docs/app-deploy.md` is stamped; §6 (domain mapping, OAuth cutover, Vercel
> decommission) stays unexecuted because the domain is not acquired.
>
> **Decisions settled here, which D4 and B1 inherit:**
> - **Region is `us-west1`, not `us-central1`.** Both runbooks derived `REGION`
>   from `GOOGLE_VERTEX_LOCATION`; those are unrelated. Service region tracks
>   the DB (Supabase is `aws-1-us-west-1`); Vertex location stays `us-central1`.
>   **D4's worker pool belongs in `us-west1` too** — it is more DB-chatty than
>   the app. The Artifact Registry repo is already there.
> - **Migrations moved into `cloudbuild.yaml`**, replacing `vercel.json`'s
>   `buildCommand`, using the Dockerfile's `deps` stage as the Prisma CLI. It
>   needs the **session-mode pooler** (`:5432` on the pooler host): the `:6543`
>   transaction pooler breaks migrate's advisory lock, and Supabase's `direct`
>   endpoint is IPv6-only, so it is unreachable from Cloud Build.
> - **Separate SAs, shared `supabase-database-url` secret** (same Postgres role
>   either way, so separate secrets buy no isolation). `worker-deploy.md` §4–5
>   updated to match.
> - Scaling **min 1 / max 4** (40 pooler connections; add D4's before raising).
>
> **Two code bugs D1 could not have caught**, both fixed in this block:
> `src/lib/api/public-origin.ts` (the `/auth/*` routes built redirects from
> `req.url`, which on Cloud Run is the container's bind address — sign-in went
> to `https://0.0.0.0:8080`; Vercel masked it), and the Dockerfile `COPY`ing the
> generated, gitignored `next-env.d.ts`, so the image could not build from a
> clean checkout. A `.gcloudignore` now stops `gcloud` inheriting `.gitignore`
> for the upload context.
>
> **Ops facts worth carrying:** Supabase matches the **full** redirect URL
> including query string, so the allowlist needs `https://<host>/**`, and a miss
> silently falls back to Site URL (still `http://localhost:3000`). Cloud Build
> runs as the **compute default SA**, not the legacy cloudbuild one, and its
> `roles/editor` does not include Secret Manager. `--allow-unauthenticated`
> warns rather than fails when the build SA can't set IAM policy.
>
> **B1 confirmation:** `jsonPayload` lines arrive in Cloud Logging with `event`
> and `traceId` but **empty `severity`** — exactly the gap B1 exists to close.

- Cloud Build → Artifact Registry (reuse the `$REPO` from worker-deploy.md), Cloud Run
  **service** (not worker pool) with Secret Manager-mounted env (Supabase URL + anon/service
  keys, Vertex project/location, YouTube key, etc. — inventory from `.env.example`),
  ADC for Vertex (no key JSON — same pattern as the worker).
- Custom domain mapping (user is acquiring the domain), then the **Supabase OAuth
  cutover**: update Site URL + redirect allowlist in the Supabase dashboard and the
  Google OAuth client's authorized origins/redirects. Sequence it so the Vercel deploy
  keeps working until the new domain verifies, then decommission Vercel.
- Smoke: sign-in round-trip on the new domain, program creation 202, admin pages gated.

**OPEN:** `min-instances` 0 vs 1 (cold-start vs ~$15–30/mo before credits — decide at
deploy); whether the Vercel URL should 301 to the new domain for a grace period; env
drift audit (`.env.example` completeness) belongs to this block.

### D4 — Cloud Run worker pools live (ops)

Follow `docs/worker-deploy.md` end-to-end (it's complete and was verified against the
project's GCP state on 2026-07-13) with the Supabase DB URL as the queue/database. Start
at 1 instance; the compose workers (`docker compose --profile workers`) are retired from
duty (kept for local dev). Verify: enqueue a real course request on the new domain, watch
a cloud worker claim + build it, structured logs visible in Cloud Logging.

---

## Feature B — GCP-native error reporting

### B1 — severity mapping + client-error endpoint + alerting (~80 LOC + console ops)

- `src/lib/log.ts`: emit Cloud Logging's special fields alongside the existing shape —
  `severity` (`INFO`/`WARNING`/`ERROR`) derived from `level`, and for `logError` include
  the stack in `message`/`stack_trace` form that **Error Reporting** auto-groups
  (`@type: type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent`
  or a message containing the stack — check current GCP docs at build time). Existing
  fields stay (the `jq`-ability of H3 logs is load-bearing for cost auditing).
- Client errors: a global error boundary (`src/app/global-error.tsx` + the route-level
  `error.tsx` files as appropriate) that POSTs `{ message, stack, url }` to a small
  `/api/client-error` route which `logError`s it server-side (thus into Error Reporting).
  This endpoint is an abuse surface: same-origin enforcement (H2 wrappers), payload size
  cap, and a per-IP/user rate limit or sampling.
- Ops: a Cloud Monitoring alert policy on new Error Reporting groups → email. Verify by
  forcing one server error and one client error in prod and seeing both grouped +
  alerted.

**OPEN:** rate-limit mechanism for `/api/client-error` (reuse the H1 burst-limit pattern
vs. simple in-memory token bucket — note multi-instance Cloud Run makes in-memory weak);
whether the worker (a tsx process, not Next) needs any change (it already writes JSON to
stdout — likely just the severity mapping, which it inherits from `log.ts`).

---

## Feature C — warm-path campaign

### C1 — `reset-maps` + `warm-paths` scripts (~120 LOC)

- `scripts/reset-maps.ts`: like `reset-content.ts` (dry-run default, `--yes` to execute,
  JSON snapshot to `backups/` first) but wiping ONLY the map/track/program layer:
  `LessonResource`, `Exercise`, `Section`, `Lesson`, `Track`, `ConceptResource`,
  `ConceptPrereq`, `ConceptQuestion` (cascades with Concept anyway), `Concept`,
  `RemediationJob`, `CourseRequest`, `Progress`, `EnrolledProgram`, `ProgramPath`,
  `Program`, `Path` — **keeping `Resource`, `Source`, `TopicAlias`, `User`,
  `ResourceRating`**. Dev enrollments/progress are lost — acceptable pre-beta.
- `scripts/warm-paths.ts`: takes the topic list (flag or the built-in warm set), enqueues
  a build per topic for the workers to drain (or `ensurePathMap` + remediate inline,
  prewarm-style, behind a `--inline` flag for local runs). Idempotent: a topic whose Path
  is already `spine_ready` is skipped unless `--force`.
- `TOPIC_RELATIONS` additions land here too (code constant in `src/types/resource.ts`):
  at minimum `data-structures-algorithms` ↔ `python`/`javascript`, `precalculus` ↔
  `calculus`, `sql` ↔ `python-data-ml`. Decide each edge deliberately — relatedness
  widens search bleed (see the design record in ROADMAP).

**OPEN:** whether warm-paths enqueues `CourseRequest` rows directly or goes through
`ensurePathMap` (look at what the worker expects — a CourseRequest is Track-oriented;
warming wants the *Path/map* built, which `ensurePathMap` + remediation does without a
learner). Likely: inline `ensurePathMap` + `remediatePath` per topic, bounded
concurrency; the CourseRequest queue is for real learner requests. Verify against
`scripts/prewarm.ts`, which already does exactly this for one topic.

### C2 — the campaign itself (ops; no code)

Runs **after D4** (cloud workers + Supabase library) **and after topic-filing T4**
(`docs/topic-filing-plan.md`) — it is the shakedown run for both.

> ⚠️ **Added dependency on topic-filing T4 (2026-07-25).** Measured on the dev DB while
> verifying C1: **933 of 1,927 resources (~48%) are unreachable by the warm set.** The warm
> topic `statistics` has **0** rows while `probability-and-statistics` — a different,
> agent-minted canonical with no relation edge — holds **456**; `discrete-mathematics` (276),
> `calculus-for-machine-learning` (188), `differential-equations` (12) and `differentiation`
> (1) are reachable from no warm topic at all. `data-structures-algorithms` and
> `physics-mechanics` have 0 rows each, and the DSA curated slug has a drifted `TopicAlias`
> twin (`data-structures-and-algorithms`) that its C1 relation edges don't key onto.
>
> Running C2 before T4 would web-source `statistics` from scratch and build a parallel
> duplicate of an existing 456-row pool — wasted spend and a worse Path — then freeze the
> mis-filing into 12 warm Paths. T4's bulk reclassification + drift merge is what makes the
> library reachable; C2 should consume that, not race it.
>
> **OPEN, and it determines `WARM_TOPICS`:** which slug is canonical for the stats pool —
> curated `statistics`, or agent-minted `probability-and-statistics`? T4 step 2 merges
> `probability` → `probability-and-statistics` but does not reconcile it with the curated
> slug. `WARM_TOPICS` derives from `TOPIC_SLUGS`, so `warm-paths.ts` follows whichever way
> this is settled — but it must be settled in T4, not here.
>
> A second C1 measurement worth carrying in: warming `precalculus` cold reached 76
> calculus-filed resources through the new relation edge and **skipped web discovery
> entirely**, because the library rung counts raw hits rather than judged-`teaches`
> survivors (locked tradeoff, `web-fallback.ts:171-173`). Three spine concepts relaxed to
> hollow. Expect the same shape on any warm topic whose shelf is mostly borrowed — step 5
> below should check for `relaxed`/hollow concepts, not just `spine_ready`.

1. `reset-maps` against Supabase (should be near-empty of maps anyway post-D2).
2. New topics need sources: check `data/seed-sources.ts` coverage for `sql`,
   `data-structures-algorithms`, `precalculus`, `physics-mechanics` (Khan Academy, MIT
   OCW, freeCodeCamp etc. may already cover them; add allowlist rows where thin —
   **OPEN:** which channels/sites per new topic, settle in the campaign conversation).
3. `warm-paths.ts` over the 12: **python, python-data-ml, javascript, javascript-react,
   calculus, linear-algebra, machine-learning, statistics, sql,
   data-structures-algorithms, precalculus, physics-mechanics** (`go` deliberately
   dropped — off-niche).
4. Review passes, repeating until the pending queue is drained: `/decompose` for flagged
   containers, `/review-pending-resources` batches (rejects self-propagate — fact 1).
5. Re-remediate any Paths the rejects regressed (`scripts/remediate.ts`) until all 12 are
   `spine_ready`; spot-build one Track per topic and skim it in the notebook UI.
   `spine_ready` is necessary but NOT sufficient — also check each Path for
   `Concept.primaryRelaxed` rows and the map review's `hollow` findings, which is where a
   borrowed-shelf topic hides its gaps (see the C1 precalculus measurement above).
6. Record per-topic outcomes (sources used, trust distribution, holes escalated) in the
   campaign conversation for the beta announcement's honesty.

---

## Explicitly deferred (post-beta)

- **Stripe + audit Block 5** (atomic metering) — Block 5 still lands *first* whenever
  Stripe restarts; that ordering survives this plan.
- Audit blocks 6–10, remaining Phase 3.1 items — unchanged.
- Eviction **restore** operator surface (A4 designs for it).
- Aggregate rating display / per-concept ratings — revisit with beta data.
- Cloud SQL / GCP auth — not happening; Supabase is locked.
