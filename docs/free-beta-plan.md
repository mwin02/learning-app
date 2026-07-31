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
| C2 | Warm campaign: rebuild the 12 warm topics + review passes | ops | A*, D4, C1, **topic-filing T4**, **E1** |
| E1 | Operator tooling: document the local-app/remote-DB pattern | docs + code | D3 |
| E2 | Operator tooling: real admin auth for the review skills | code | D3, E1 |

Rationale for the order: ratings are platform-independent code and should be live before
beta users arrive; the migration lands **before** the warm campaign so beta traffic and the
warm builds both run on the final architecture (C2 doubles as the cloud workers' shakedown);
observability is verified against Cloud Run, so it follows D3. **E1 gates C2** — the review
passes in C2 step 4 are worthless if they drain the wrong queue.

A-blocks stack off each other (branch per block, stacked PRs — merge bottom-up per the
CLAUDE.md stacked-chain procedure). D/B/C/E blocks are independent branches off `main`.

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
| Operator tooling target | **Local app, remote DB** for now (decided 2026-07-30): run the dev server with `DATABASE_URL` overridden to the Supabase pooler, leaving `.env.local` alone. Real admin auth against the deployed service is the durable answer and is deferred to E2. `.env.local`'s `DATABASE_URL` **stays on local Docker Postgres** — that is load-bearing for integration tests and the compose workers, not an oversight. |

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
>
> **Auto-deploy is wired** (`deploy-main`, a 2nd-gen Cloud Build trigger on push
> to `main`), replacing what Vercel's `buildCommand` did. 1st-gen GitHub triggers
> could not be made to work in this project; `--service-account` is mandatory for
> 2nd-gen triggers and its absence returns an opaque `INVALID_ARGUMENT`, which
> forces `options.logging: CLOUD_LOGGING_ONLY` in `cloudbuild.yaml`. Builds are
> now **regional** — `gcloud builds list` without `--region=us-west1` shows
> nothing. `app-deploy.md` §3b has the whole path.

- Cloud Build → Artifact Registry (reuse the `$REPO` from worker-deploy.md), Cloud Run
  **service** (not worker pool) with Secret Manager-mounted env (Supabase URL + anon/service
  keys, Vertex project/location, YouTube key, etc. — inventory from `.env.example`),
  ADC for Vertex (no key JSON — same pattern as the worker).
- Custom domain mapping (user is acquiring the domain), then the **Supabase OAuth
  cutover**: update Site URL + redirect allowlist in the Supabase dashboard and the
  Google OAuth client's authorized origins/redirects. Sequence it so the Vercel deploy
  keeps working until the new domain verifies, then decommission Vercel.
- Smoke: sign-in round-trip on the new domain, program creation 202, admin pages gated.

**OPEN:** ~~`min-instances` 0 vs 1~~ — resolved twice: deployed at 1 (2026-07-29, credits
absorbed the idle), flipped to 0 when the credits' expiry was announced (2026-07-30);
see `app-deploy.md` §5. Whether the Vercel URL should 301 to the new domain for a grace period; env
drift audit (`.env.example` completeness) belongs to this block.

### D4 — Cloud Run worker pools live (ops)

Follow `docs/worker-deploy.md` end-to-end (it's complete and was verified against the
project's GCP state on 2026-07-13) with the Supabase DB URL as the queue/database. Start
at 1 instance; the compose workers (`docker compose --profile workers`) are retired from
duty (kept for local dev).

> **Cost (2026-07-30, credits expiring): host the worker on the free-tier `e2-micro`,
> not a min-1 Cloud Run service.** The worker polls the DB, so it can never scale to
> zero — on Cloud Run that's another ~$50/mo of always-allocated idle. The always-free
> tier includes one non-preemptible `e2-micro` VM (2 shared vCPU / 1 GB) + 30 GB standard
> disk in `us-west1` — the region the worker wants anyway (DB co-location, same argument
> as the app). Run the existing worker image on it via Container-Optimized OS or plain
> Docker; `worker-deploy.md`'s image, SA, and secret wiring still apply, only the host
> changes. One caveat to verify at creation: external IPv4 is now billed (~$3/mo) and the
> free-tier exemption for it has shifted over time — the worker needs no inbound traffic,
> only outbound (Supabase, Vertex), so an external IP is purely for egress; check the
> current pricing note before assuming it's free. Revisit Cloud Run for the worker only
> when queue depth needs >1 instance (that scaling point is also when revenue exists). Verify: enqueue a real course request on the new domain, watch
a cloud worker claim + build it, structured logs visible in Cloud Logging.

> **LIVE 2026-07-31** — `course-worker` `e2-micro` running in **`us-central1-a`**, draining
> the production queue. It cleared a real 47-hour-old backlog on first boot
> (`linear-algebra` 13m41s/22 lessons, `machine-learning` 13m15s/13 lessons), proving the
> ADC path, the pooler connection, and structured logging in one pass. Verification table
> in `worker-deploy.md` §11 — **all five steps pass**, including the graceful requeue (claim
> released in 1s) and the crash path (`course-request.reclaimed-stale` at exactly
> `claimedAt + 45m00s`, re-claimed 1s later by the rebooted worker).
>
> **Finding for C2, surfaced by the step-4 build: `precalculus` cannot currently build on
> production.** A clean cold run authored 22 concepts (13 spine, 9 frontier) and left
> **exactly one SPINE concept with no candidate resource** —
> `function-transformations-and-compositions` — so readiness never reached `spine_ready` and
> the request terminated `failed` with `spine holes left uncoverable`. Remediation otherwise
> worked: it relaxed two concepts (`polynomial-functions`, `unit-circle-and-angle-measure`)
> onto sub-floor primaries, and escalated the one it genuinely could not cover.
>
> ⚠️ An earlier draft of this note claimed remediation "escalated only 1 of 4 holes,
> suggesting the ladder stopped early." **That was wrong** — a measurement error, counting
> zero-resource concepts across the whole Path when `recomputeReadiness` only considers
> `membership: spine` (`recompute-readiness.ts:41`). The other three zero-resource concepts
> are **frontier**, where having no resource is the normal state. There is no evidence the
> sourcing ladder misbehaves. The real gap is narrow and tractable: one spine concept needs
> one acceptable resource. Repeat the membership check before reading any future hole count
> as a bug.
>
> **Region: `us-central1`, not `us-west1`** (decided 2026-07-31). `e2-micro` capacity was
> exhausted in **all three** `us-west1` zones — confirmed `resource_availability`, not quota
> (E2_CPUS limit 100, usage 0) — across 18 attempts over ~10 minutes. Cost is identical
> (both are Always Free regions; only a ~$0.01/mo cross-region image pull differs), so the
> trade is purely the latency of leaving the DB's region. **The latency cost is UNMEASURED**
> — production builds ran 13-14 minutes, but the local comparison isn't valid (the prod
> paths weren't warm), so don't cite that as evidence either way. Moving back is cheap
> because the VM is stateless: recreate in a `us-west1` zone, verify, delete. The only thing
> that would make it expensive is anything keyed to the worker's egress IP
> (`104.197.62.19`), e.g. Supabase network restrictions.
>
> **Three bugs found by running it, none of which review would have caught:**
> 1. **COS's root filesystem is read-only**, so `docker login` fails on
>    `mkdir /root/.docker` and `set -e` kills the script before `docker pull` — while
>    systemd still reports `status=0/SUCCESS`. Externally it looks like a healthy VM with no
>    container. Fixed with `DOCKER_CONFIG` on `/var` (plus `--password-stdin`, so the token
>    is not in argv).
> 2. **Cloud Audit Logs pollute `resource.type="gce_instance" AND severity>=ERROR`** — every
>    failed Compute API call lands there. Ten such entries fired the first alert and were
>    the audit trail of the failed `us-west1` creates. Alerting must scope to
>    `logName:"logs/cos_containers"`.
> 3. COS's cloud-init emits an ERROR (`Failed to wait for network`) on every healthy boot —
>    a second reason not to alert on resource type alone.
>
> `docs/worker-deploy.md` is restructured around the VM
> (Cloud Run worker pool demoted to §13, the scale-up path). New tracked artifacts:
> `cloudbuild.worker.yaml` and `deploy/worker-vm-startup.sh`. SA `course-worker`
> created with five roles; image `course-worker:2e3330c` built and pushed.
> **Blocked on `e2-micro` capacity** — all three `us-west1` zones returned
> `resource_availability` on create. Decision (2026-07-31): keep retrying `us-west1`
> rather than take a free-tier zone in `us-central1`/`us-east1`, because the
> region-tracks-the-database rule is worth more than landing a day earlier, and
> nothing but C2 waits on D4.
>
> **The 1 GB RAM risk was measured, not assumed** (local compose worker, 2026-07-31):
> idle **229 MiB**; warm build (`calculus`, 0 holes, 444-resource library, 216s)
> **253 MiB**; cold build (`data-structures-algorithms`, no Path, spine authoring +
> sourcing ladder + track build, 1346s) **273 MiB**. A full cold build costs 44 MiB
> over idle, not a multiple — the worker is one sequential pipeline that streams
> responses and writes rows. `e2-micro` is comfortable; the startup script's 768m
> container cap is 2.8× observed peak. First measurement attempt (`graph-theory`)
> was discarded: it escalated in 44s without doing real sourcing.
>
> **Three things the plan's cost note did not anticipate:**
> - **The worker does not auto-deploy.** The app rebuilds and deploys on every merge
>   to `main`; the VM runs whatever tag its metadata names. Shipping a worker change
>   is build → `add-metadata` → `reset` (worker-deploy.md §9). A Cloud Build trigger
>   would build but still not deploy, which is worse — it looks automated.
> - **`gcloud compute instances reset` is a hard power cycle**, not a graceful
>   restart: no SIGTERM, so the in-flight claim waits out the 45m stale reclaim.
> - **Logs are not free here.** Cloud Run forwarded container stdout to Cloud Logging
>   automatically; a GCE VM needs `google-logging-enabled=true` metadata plus
>   `roles/logging.logWriter`. Whether COS's fluent-bit parses our JSON lines into
>   `jsonPayload` with `severity` intact is **undocumented** and is the one real
>   verification risk — B1's worker error-reporting half depends on it.
>
> External IPv4 confirmed **not** free-tier exempt (~$2.92/mo) and unavoidable:
> Private Google Access would cover Vertex and Artifact Registry, but Supabase is on
> AWS, so the worker needs real internet egress. Cloud NAT costs an order of
> magnitude more.

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

> **DONE 2026-07-30 (code + runbook); the notification channel is the one
> remaining console step.** `docs/app-deploy.md` §8 is the runbook.
>
> **The plan's design was incomplete, and the gap is the interesting part.** A
> client error boundary CANNOT capture server errors: in production Next replaces
> a Server Component's error with a generic message plus a `digest` before the
> boundary sees it, so a boundary POSTing what it was handed reports no stack and
> nothing groups. B1 therefore adds `src/instrumentation.ts` (`onRequestError`),
> which sees the real error, its stack, the digest, `request.path` and
> `context.routeType` — and also covers unhandled throws in route handlers and
> Server Actions, which nothing covered before. Both sides log the `digest`, so
> the two records join. Verified locally: the same forced error produced a
> `server.unhandled` line and a `client.unhandled` line sharing digest
> `1871428373`.
>
> **The `@type` question is settled**: a stack in `message`/`stack_trace`/
> `exception` auto-groups on its own; `@type` ReportedErrorEvent is needed only
> for a stack-less error. `log.ts` does both conditionally.
>
> **`serializable()` was dropping every stack** (`{ name, message }` only), so
> the severity mapping alone would have grouped nothing. `takeStack` now MOVES the
> stack into `message` rather than copying it — the first cut had every stack in
> the line twice, which Cloud Logging bills for.
>
> **Rate limit: per-instance token bucket** (20 burst, 1/3s), not the H1 DB
> pattern. The endpoint must be unauthenticated (no session on a sign-in-page
> crash, so no key to count rows against) and a Postgres round trip would put the
> DB on the failure path of the one endpoint whose job is to work while the app is
> broken. min-instances is now **0** (not 1 — `5742126`), so the guarantee is
> weak by construction; accepted, because what it bounds is the log bill, and
> client-side dedupe (3 distinct reports per page load) plus Error Reporting's own
> 5-per-group-per-hour cap carry the rest. The throttle logs at `WARNING`, never
> `ERROR`, so it cannot page on itself.
>
> **Worker: `LOG_SERVICE_NAME=course-worker` baked into `Dockerfile.worker`**
> (Cloud Run injects `K_SERVICE`; a plain container has none), plus terminal
> `unhandledRejection`/`uncaughtException` handlers — with `restart:
> unless-stopped` a crash loop was previously silent. Cloud verification of the
> worker half waits on D4.
>
> **Scope call: all 20 raw `console.error` sites converted to `logError`.** The
> brief named two files; there were twenty, mostly in `src/lib/agents/`
> (`remediate-path`, `attach-candidates`, `generate-onramp`, `topic-gate`) — the
> autonomous pipeline that fails unattended. Against only 8 pre-existing
> `logError` sites, skipping this would have made B1 largely decorative. The
> remaining 78 `console.log` + 28 `console.warn` are deliberately left for a
> follow-up sweep.
>
> **Alerting:** Error Reporting's own **Configure notifications** → a Monitoring
> email channel, NOT a Monitoring alert policy on a metric — notifications on new
> groups are project-level and **console-only** (no gcloud/API surface), so they
> are a runbook step. Email to `david.hong199@gmail.com`, notify on every new
> group while traffic is zero.
>
> **Prod verification needed something that throws on demand**, and nothing did.
> Added `GET /api/health?probe=throw` — admin-only and non-enumerable like
> `probe=ai`, with a fixed self-identifying message so repeated drills reuse one
> Error Reporting group instead of firing a new-group notification each run. It
> exercises the route-handler path (`routeType: "route"`), which is the half a
> browser crash can never reach.
>
> **Merged as #289 and verified on Cloud Run** (revision
> `learning-app-00008-fv9`, 2026-07-30). Measured before the deploy: **zero
> `severity>=ERROR` log entries in 7 days**. After: a labelled drill produced a
> correctly-shaped ERROR line (severity, `serviceContext` carrying the revision
> via `K_REVISION`, stack in `message`, stack removed from the report field, no
> `@type`) and **grouped in Error Reporting**. The gated probes proved
> non-enumerable in prod where `devBypass` is false — `?probe=throw` and
> `?probe=ai` both return the plain liveness body. `app-deploy.md` §8 has the
> full record.
>
> **One prerequisite the plan and the first cut of the runbook both missed:
> `clouderrorreporting.googleapis.com` was DISABLED** on the project — a day
> after the app went live. Until it is enabled, ERROR lines reach Cloud Logging
> but nothing groups and there is no console surface for notifications. Enabled
> 2026-07-30; §8 now leads with it. (`gcloud beta` is also needed for the
> `error-reporting` / `monitoring channels` command groups.)
>
> **Ops half completed 2026-07-31.** Channel wired and verified enabled;
> `?probe=throw` with an admin session grouped as `server.unhandled`
> (`routeType: "route"`, ten frames in `message`, revision in `serviceContext`).
> Two drills with different messages produced two distinct groups, confirming the
> fixed probe message will reuse one group rather than notifying on every run.
> **Only the worker half is left, and it is blocked on D4.**
>
> Also noted: Next 16.2 renamed the boundary's retry prop to `unstable_retry`.

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

---

## Feature E — operator tooling against the deployed database

**Why this exists (surfaced 2026-07-30, during D3).** The five review skills are the
operator surface for curation, and **every one of them reaches a local target** — four via
`localhost:3000`, the fifth via a direct-DB script — which resolves through `.env.local` →
**local Docker Postgres**. Post-D2 the library that matters lives on Supabase. So the
tooling and the data have come apart: a review pass drains the *local* queue and changes
nothing about what beta users will see. D3 didn't break this; it made it visible.

### Codebase facts (verified 2026-07-30)

1. **Four of the five skills hardcode `localhost:3000`** in both their prerequisites and
   every `curl`: `review-pending-resources` (`/api/playground/pending-resources`),
   `review-map-findings` (`/api/playground/map-review`), `author-concept-bank`
   (`/api/playground/concept-banks`), `decompose` (`/api/playground/decomposition-review`).
   For `decompose` the string is in four `references/*.md` as well as `SKILL.md`, so E2's
   base-URL change is a wider edit there than "one file per skill" suggests.
   `review-topic-filing` is the fifth and is different — it contains no `localhost:3000` at
   all, bypassing HTTP entirely to drive
   `.claude/skills/review-topic-filing/scripts/topic-review.ts` against the DB.
2. **The two direct-DB helpers follow `DATABASE_URL`**, so they inherit whatever the
   invocation's env says: `pending-review-db.cjs` builds its own client from
   `process.env.DATABASE_URL`; `topic-review.ts` imports the `@/lib/db` singleton. Both are
   documented as `--env-file=.env.local`.
3. **`DEV_AUTH` cannot work in cloud, by construction.** `devBypass()` is
   `NODE_ENV === 'development' && DEV_AUTH === '1'` (`src/lib/api/with-auth.ts:33`), and
   Next's standalone server hardcodes `NODE_ENV=production`. Every skill's probe expects
   `DEV_AUTH=1`. Confirmed live against Cloud Run: `/api/playground/concept-banks` returns
   **404** for a signed-in non-admin (non-enumerable by design, per `with-admin-auth.ts`).
4. **There is no admin on the deployed service.** The Supabase `User` table had 0 rows until
   D3's sign-in smoke created one, with the default role. Roles are assigned by hand — "there
   is deliberately no API for it" (`with-admin-auth.ts` header).

### E1 — document the local-app/remote-DB pattern (docs + ~15 LOC)

The locked stopgap. Run the app locally (so `NODE_ENV=development` and `DEV_AUTH=1` still
apply) against the **Supabase pooler**, without touching `.env.local`:

```bash
DATABASE_URL="$SUPABASE_POOLER_URL" npm run dev
```

Every skill then works unchanged and writes to Supabase. Same override for the two direct-DB
helpers, since shell env beats `--env-file`.

Deliverables: a section in `docs/app-deploy.md` (or a short `docs/operator-tooling.md`) and a
prerequisite line in each affected skill saying which DB the server was started against.

**The hazards to write down, because they are the whole risk of this pattern:**
- **The target is invisible at the call site.** A skill's `curl localhost:3000/…` looks
  identical whichever DB the server was started against. There is no way to tell from the
  command which library you are editing. Get in the habit of confirming before a review pass.
- **Use the POOLER url (`:6543`), not `SUPABASE_DB_URL`.** The latter is the direct 5432
  endpoint and is **IPv6-only** on current Supabase projects — it happens to work from a
  laptop, which is exactly what makes it a trap to standardise on.
- **Never solve this by editing `.env.local`.** The setting outlives the command, and the next
  `npm run test:int` or `docker compose --profile workers up` inherits it — writing test
  fixtures into the live library and draining the production queue from a laptop.
- Reviews mutate production curation with `DEV_AUTH`-level (i.e. no) authentication. Fine for
  a single operator on a laptop; not fine as a standing arrangement. Hence E2.

**RESOLVED (2026-07-31) — the target is logged, not just documented.** Taken the
server-log option over the health-probe one: it covers all four HTTP skills at once with no
per-skill wiring, and it leaves D1's deliberately content-free `/api/health` alone. A pure
`describeDatabaseUrl(raw)` → `host:port/dbname` (`src/lib/db-target.ts`, credentials
stripped, unit-tested) is now the single formatter for every announcer — the app, the ops
guard, and, by hand, the two CJS skill helpers — so one recognisable string means the same
database everywhere. `src/lib/db.ts` emits `log('db.client_created', { target })` where it
already resolves `DATABASE_URL`.

One correction to the framing above: this is **not** a boot banner. The Prisma singleton is
built at module eval, which under `next dev` is the first request that touches the DB — so
the line lands in the dev-server terminal in response to a skill's own precondition probe,
ahead of any mutation, and is emitted once per process. Verified locally 2026-07-31:
`{"event":"db.client_created","severity":"INFO","target":"localhost:55432/learning_app"}`.

**Delivered:** `docs/operator-tooling.md` (chosen over an `app-deploy.md` section — that doc
is about deploying the service, this is about pointing a laptop at production data, and it
dies at E2); `app-deploy.md` §7 and §8 now link it, replacing §8's "E1 will document it
properly" placeholder; a target-confirmation precondition in each of the four HTTP skills
(`review-topic-filing` already had one and was the model copied).

### E2 — real admin auth for the review skills (~100–150 LOC + ops)

The durable answer, and the one that lets the skills operate the **deployed** service rather
than a laptop pointed at production data.

- Set `role='admin'` on the operator's Supabase `User` row (hand-written SQL — fact 4). Worth
  doing early regardless: there is currently no admin on production at all.
- Give the skills a **configurable base URL** instead of a hardcoded `localhost:3000`, and
  make them authenticate with a real session rather than `DEV_AUTH`. The existing pattern for
  authed live verification is the Chrome page-context `fetch` (it carries the session cookies
  and a same-origin `Origin`, which `requireSameOrigin` needs for mutating calls).
- Retire `DEV_AUTH` from the operator path. `.env.example` has always described it as going
  away "once the real flow is trusted end-to-end" — after D3 it is.

**OPEN (settle in E2's discussion):**
- Where the base URL comes from: an env var, a skill argument, or a probe. It must **fail
  closed** — a skill that silently falls back to `localhost:3000` when the intended target is
  production reintroduces E1's invisible-target hazard in a worse form.
- Whether `review-topic-filing` converges on HTTP like the other four, or stays a direct-DB
  script (it is script-shaped for good reasons — bulk reclassification — and for it the
  `DATABASE_URL` override is arguably already the right interface).
- Whether the mutating playground routes need anything beyond `withAdminAuth` before they are
  driven against production (audit trail on `origin: 'review'` writes already exists; check
  whether it records *which* admin).
- Whether an operator UI is in scope at all, or the skills remain the surface for beta.

## Explicitly deferred (post-beta)

- **Stripe + audit Block 5** (atomic metering) — Block 5 still lands *first* whenever
  Stripe restarts; that ordering survives this plan.
- Audit blocks 6–10, remaining Phase 3.1 items — unchanged.
- Eviction **restore** operator surface (A4 designs for it).
- Aggregate rating display / per-concept ratings — revisit with beta data.
- Cloud SQL / GCP auth — not happening; Supabase is locked.
