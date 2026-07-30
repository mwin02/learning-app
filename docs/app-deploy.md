# App deploy — Cloud Run service

How to take the containerized Next.js app (`Dockerfile`, free-beta Block D1)
from a local Docker run to a **Google Cloud Run service**, and cut Vercel over
to it. Companion to [`worker-deploy.md`](worker-deploy.md), which covers the
worker-pool half of the same migration; the two share a GCP project, an
Artifact Registry repo, and the Supabase database.

> **Status: §0–§5 and §7 verified against GCP 2026-07-29** (free-beta D3). The
> service is live on its `*.run.app` URL and every command below was run as
> written. **§6 (custom domain + OAuth cutover + Vercel decommission) is still
> unexecuted** — the domain is not acquired yet, so D3 was deliberately split.
> Vercel is still running and still owns nothing; see §4a for what replaced its
> `buildCommand`.

## 0. What the image is

Three-stage build off `output: 'standalone'` (`next.config.ts`):

| Stage | Does |
| --- | --- |
| `deps` | `npm ci` on `node:22-slim`; the postinstall hook runs `prisma generate` |
| `builder` | `next build` → `.next/standalone` (traced subset of `node_modules` + a minimal `server.js`) |
| `runner` | copies `.next/standalone`, `.next/static`, `public`; runs as `node`, listens on `$PORT` |

Measured on the D1 build: **440 MB image, ~192 MiB RSS idle, boot to first
byte under a second.** That sizes the Cloud Run service at **1 vCPU / 512 MiB**
comfortably; 1 GiB if you want headroom for concurrent SSR.

**No Prisma engine binary is involved.** Prisma 7 generates a WASM query
compiler and reaches Postgres through `@prisma/adapter-pg`, so the client is
architecture-independent — the musl-vs-debian engine question that dogs older
Prisma Docker setups does not arise here. In the traced output `pg` and its
dependency tree land in `node_modules` (Next externalizes them) while
`@prisma/adapter-pg` is bundled into the route chunks. Both paths are exercised
by the DB probe below.

### Build-time vs runtime env — the one asymmetry vs. the worker

The worker takes **every** value at runtime. The app cannot: `next build`
**inlines `NEXT_PUBLIC_*` into the client bundle**, so those two are
`--build-arg`s and the resulting image is **bound to one Supabase project**.
Rotating the anon key means rebuilding and redeploying the image, not
restarting the service.

| Variable | When | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | **build** | inlined into client JS |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **build** | inlined into client JS; safe to expose by design |
| `DATABASE_URL` | runtime | Supabase **transaction-pooler** URL (6543), Secret Manager |
| `GOOGLE_VERTEX_PROJECT` / `GOOGLE_VERTEX_LOCATION` | runtime | plain env |
| `GOOGLE_VERTEX_ANTHROPIC_LOCATION` / `GOOGLE_VERTEX_GEMINI3_LOCATION` | runtime | optional, both default `global` |
| `YOUTUBE_API_KEY` | runtime | optional, Secret Manager |
| `APP_ORIGIN` | runtime | optional; set once the custom domain is live if the proxy's forwarded host differs |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | — | **leave unset in cloud.** Its absence selects the ADC path (`src/lib/ai/vertex.ts`), authenticating as the runtime service account |
| `DIRECT_URL` | — | not needed: Prisma-CLI-only (migrations); the build's `prisma generate` uses `prisma.config.ts`'s placeholder fallback |
| `DEV_AUTH` | — | **never set in cloud.** Inert anyway: Next's standalone server hardcodes `NODE_ENV=production` |

`TRACE_RESPONSE` used to have a row here. It is **dead** — removed along with
the synchronous path-generation route in the playground revamp (`d1d4715`), and
no code has read it since. The D3 env-drift audit deleted it from
`.env.example`; don't reintroduce the name.

The builder stage sets placeholder `DATABASE_URL` / `GOOGLE_VERTEX_PROJECT` /
`GOOGLE_VERTEX_LOCATION` values because `src/lib/db.ts` and `src/lib/ai/vertex.ts`
validate env at **module eval** and `next build` evaluates route modules while
collecting page data. Every route is dynamic (`ƒ` in the build output), so
nothing connects at build time and no placeholder is baked into the output.

## 1. Local verification (D1 gate — run this before any cloud step)

```bash
set -a; . ./.env.local; set +a
docker build -t learning-app \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" .
```

Run it against the local Docker Postgres. `--env-file` does **not** strip
quotes and does **not** accept multi-line values, so don't point it at
`.env.local` — write a flat file, rewriting `localhost` to
`host.docker.internal` so the container can reach the host's Postgres:

```bash
docker run --rm -p 8080:8080 --env-file /tmp/container.env learning-app
```

Checks:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/            # 200 (SSR)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/file.svg    # 200 (public/)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/programs    # 307 → /signin
curl -s http://localhost:8080/api/health                                   # {"ok":true,…}
curl -s http://localhost:8080/api/health?probe=db                          # {"ok":true,"db":"up",…}
```

`?probe=db` is the load-bearing one: it runs `SELECT 1` through the Prisma
adapter, which is the only way to prove the traced `pg` + bundled adapter +
WASM compiler all survived the standalone build. Confirm it can also fail —
run the image with a junk `DATABASE_URL` and expect `503 {"ok":false,"db":"down"}`,
otherwise the probe is proving nothing.

## 2. Prerequisites for the cloud steps

Same project, region, and Artifact Registry repo as `worker-deploy.md` §1–2 —
if the worker is already deployed, the APIs and repo exist and you can skip
straight to §3.

```bash
export PROJECT_ID=learning-app-prod-mzw
export REGION=us-west1            # the SERVICE's region — see below
export VERTEX_LOCATION=us-central1
export REPO=learning-app
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/learning-app
export SA=learning-app@$PROJECT_ID.iam.gserviceaccount.com
```

> ⚠️ **`REGION` is not `GOOGLE_VERTEX_LOCATION`.** Both runbooks used to derive
> one from the other (`REGION=$(grep GOOGLE_VERTEX_LOCATION …)`). They are
> unrelated. The service region tracks the **database** — Supabase is in
> `aws-1-us-west-1`, and every SSR render makes several Prisma round trips, so
> a `us-central1` service pays a cross-country hop on each one. Vercel's `sfo1`
> was co-located for exactly this reason. `GOOGLE_VERTEX_LOCATION` stays
> `us-central1` because that is where the models are served. **D4's worker pool
> should land in `us-west1` too** — it is far more DB-chatty than the app.

APIs and the Artifact Registry repo are `worker-deploy.md` §1–2, run here for
the first time on 2026-07-29 (the project was greenfield: only `aiplatform`,
`logging` and `monitoring` were on). D4 inherits both — the repo is
`us-west1-docker.pkg.dev/learning-app-prod-mzw/learning-app`.

## 3. Build, migrate & deploy — one pipeline

`cloudbuild.yaml` at the repo root does all of it: build the `deps` stage as a
throwaway migrator image, build the app image, push, `prisma migrate deploy`,
then `gcloud run deploy`. Read its header comments before changing it.

```bash
set -a; . ./.env.local; set +a
gcloud builds submit --project $PROJECT_ID --config cloudbuild.yaml \
  --substitutions=_TAG=$(git rev-parse --short HEAD),\
_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL",_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" .
```

~4m30s end to end. Cloud Build rather than a local `docker build` for the same
reason as the worker: Apple Silicon produces an arm64 image Cloud Run can't
run. Substitutions rather than a bare `--tag` because the two `NEXT_PUBLIC_*`
values are **build args** (§0).

Two traps this ran into, both now fixed in the repo but worth knowing:

- **`gcloud builds submit` falls back to `.gitignore`** when no `.gcloudignore`
  exists. Generated-but-required files are gitignored by definition, so the
  upload silently differs from your disk — `next-env.d.ts` was `COPY`d by the
  Dockerfile and absent from the context, and the build failed at step 9. The
  repo now has a `.gcloudignore` (keep `.env*` in it — the context is uploaded
  to a GCS bucket) and the Dockerfile no longer copies that generated file.
- The **`--allow-unauthenticated` IAM binding fails with a warning, not an
  error**, because the build service account can't set IAM policy. The deploy
  "succeeds" and the service 403s every request. On a first deploy in a fresh
  project, run this once as an owner:

  ```bash
  gcloud run services add-iam-policy-binding learning-app \
    --region=$REGION --member=allUsers --role=roles/run.invoker --project $PROJECT_ID
  ```

### 3a. Migrations — who owns them now

`vercel.json`'s `buildCommand` (`prisma migrate deploy && next build`) was the
**only** thing applying migrations to Supabase. The `migrate` step in
`cloudbuild.yaml` inherits that job; decommissioning Vercel (§6) without it
would leave the schema silently drifting from `main`.

It runs the Dockerfile's own `deps` stage, which is already a complete Prisma
CLI environment (`node_modules`, `prisma/`, `prisma.config.ts`), so there is no
second image to maintain and step 1's layers are reused from the same daemon's
cache. It sits **after** the build (never migrate for a revision that can't
compile) and **before** the deploy (never serve a revision the schema lags).

> **Which connection string.** `prisma.config.ts` reads `DIRECT_URL`, and it
> gets the **session-mode pooler** — `aws-1-us-west-1.pooler.supabase.com:5432`
> — stored as the `supabase-session-url` secret. Not the `6543` transaction
> pooler, which multiplexes at statement level and breaks the advisory lock
> migrate takes. And **not** `db.<ref>.supabase.co:5432`, the "direct"
> connection: it is **IPv6-only** on current Supabase projects, so it works from
> a laptop with IPv6 and fails from IPv4-only Cloud Build workers with a
> baffling `P1001: Can't reach database server`. Session mode is a real session
> over IPv4, which is exactly what migrate needs.

### 3b. Automatic deploys on merge (`deploy-main` trigger)

The normal path is a **Cloud Build trigger on push to `main`**, running the same
`cloudbuild.yaml`. The manual submit in §3 stays available for rebuilding an
arbitrary tree (a rollback rebuild, a hotfix off a branch).

Why triggered rather than by hand: Vercel's `buildCommand` already auto-deployed
**and auto-migrated** on every merge, so this is not new exposure — it is the
replacement for something that exists. Two side benefits: `$SHORT_SHA` is
populated for triggered builds, so every deployed image carries a real commit
tag (hand-tagging is how `5c92bc7-authfix` — a tag matching no commit — got
deployed during D3); and a triggered build is always a **clean checkout**, which
is exactly the condition that the `next-env.d.ts` bug failed under.

**Set the trigger up BEFORE decommissioning Vercel (§6), not after.** You want
it proven while a working deployment still exists. Until §6 runs, expect *two*
builds per merge — harmless, and well inside Cloud Build's 2,500 free
build-minutes/month at ~4.5 min per build.

#### The connection is 2nd gen — and 1st gen does not work here

Cloud Build has two GitHub mechanisms. **1st gen** (the "Cloud Build GitHub App"
console link, `--repo-owner`/`--repo-name`) was tried first and could not be made
to work in this project: every `triggers create` returned a bare
`INVALID_ARGUMENT` with no field violations, and 1st-gen links are **invisible to
`gcloud`** — there is no list command — so a failing trigger create is the only
probe available. Don't spend time on it; it is also the deprecated path.

**2nd gen** is what is deployed: a named `connection` + `repository` resource
pair, both inspectable, plus a regional trigger.

```
connection   github-mwin02   us-west1   (app installation 149984108)
repository   learning-app -> https://github.com/mwin02/learning-app.git
trigger      deploy-main     us-west1   push ^main$
```

#### Step 1 — the P4SA needs to create secrets (one-time)

A 2nd-gen connection stores the GitHub OAuth token in Secret Manager and manages
its IAM, so Cloud Build's **P4SA** — the Google-managed service agent
`service-<PROJECT_NUMBER>@gcp-sa-cloudbuild.iam.gserviceaccount.com`, *not* the
build SA — must be able to create secrets. Without it, `connections create`
fails with `could not assert Secret Manager permissions`.

Google's documented answer is `roles/secretmanager.admin`, which would also let
it read `supabase-database-url` and `supabase-session-url`. A custom role avoids
that:

```bash
gcloud iam roles create cloudbuildConnectionSecrets --project=$PROJECT_ID \
  --title="Cloud Build 2nd-gen connection secrets" --stage=GA \
  --permissions=secretmanager.secrets.create,secretmanager.secrets.get,secretmanager.secrets.setIamPolicy,secretmanager.secrets.getIamPolicy,secretmanager.versions.add
```

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID --member serviceAccount:service-74223797331@gcp-sa-cloudbuild.iam.gserviceaccount.com --role projects/$PROJECT_ID/roles/cloudbuildConnectionSecrets --condition=None
```

It deliberately omits **`versions.access`**: Cloud Build self-grants accessor on
the secret it creates via `setIamPolicy`, so it can read its own token but not
any pre-existing secret's value. If a future connection operation fails on a
missing permission, add that one permission — don't widen to admin.

#### Step 2 — create the connection and authorize it (browser, one-time)

```bash
gcloud builds connections create github github-mwin02 --region=us-west1 --project=$PROJECT_ID
```

It creates the connection in `PENDING_USER_OAUTH` and prints a URL. Open it,
authorize Cloud Build against the account owning the repo, and install the app
scoped to **only** `learning-app`. (Its "use a robot account" advice is for
shared setups; a personal account is fine.) Then confirm:

```bash
gcloud builds connections describe github-mwin02 --region=us-west1 --project=$PROJECT_ID --format='value(installationState.stage)'
```

`COMPLETE` means done. Register the repository:

```bash
gcloud builds repositories create learning-app --remote-uri=https://github.com/mwin02/learning-app.git --connection=github-mwin02 --region=us-west1 --project=$PROJECT_ID
```

#### Step 3 — create the trigger

```bash
set -a && . ./.env.local && set +a && gcloud builds triggers create github --name=deploy-main --repository=projects/$PROJECT_ID/locations/us-west1/connections/github-mwin02/repositories/learning-app --region=us-west1 --branch-pattern='^main$' --build-config=cloudbuild.yaml --service-account=projects/$PROJECT_ID/serviceAccounts/74223797331-compute@developer.gserviceaccount.com --substitutions=_TAG='$SHORT_SHA',_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL",_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" --ignored-files='docs/**','**/*.md','.claude/**' --project=$PROJECT_ID
```

Four things that are not optional, each of which cost a failed attempt:

- **`--service-account` is MANDATORY for 2nd-gen triggers.** Omitting it returns
  the same opaque `INVALID_ARGUMENT` as everything else. This was the actual
  blocker; the request body was otherwise byte-for-byte correct.
- **`options.logging: CLOUD_LOGGING_ONLY` in `cloudbuild.yaml`** is the knock-on:
  a build under an explicitly specified service account can't fall back to the
  legacy SA's logs bucket, and Cloud Build refuses it unless logging is pinned.
  A manual `builds submit` will *not* surface this — it uses the default identity.
- **`--region` must match the connection's region.** `--region=global` is
  rejected; the connection is regional.
- **`_TAG='$SHORT_SHA'` single-quoted** so the shell leaves it alone; Cloud Build
  expands it per build. This is what makes every auto-deployed image carry a real
  commit tag.

`--ignored-files` skips a build when a commit touches only docs/markdown. The two
`NEXT_PUBLIC_*` values are read from `.env.local` at creation time and stored on
the trigger — publishable by design (they ship in the client bundle), but
deliberately not committed, which is why the trigger is created by command rather
than checked in. `gcloud builds triggers export`/`import` round-trips it if you'd
rather version it.

#### Step 4 — verify

The first firing should be a real merge to `main`. To force one otherwise:

```bash
gcloud builds triggers run deploy-main --branch=main --region=us-west1 --project=$PROJECT_ID
```

Then confirm the running image is tagged with a real commit:

```bash
gcloud run services describe learning-app --region us-west1 --project learning-app-prod-mzw --format='value(spec.template.spec.containers[0].image)'
```

#### Operating it

| Task | Command |
| --- | --- |
| Pause auto-deploy | `gcloud builds triggers update github deploy-main --region=us-west1 --project $PROJECT_ID` with `--disabled`, or toggle it in the console |
| See what it did | `gcloud builds list --region=us-west1 --project $PROJECT_ID --limit 10 --format='table(id,status,substitutions._TAG)'` |
| Inspect the trigger | `gcloud builds triggers describe deploy-main --region=us-west1 --project $PROJECT_ID` |
| Change scaling/secrets/probe | edit `cloudbuild.yaml` and merge — the deploy step is declarative |

Note builds are now **regional** (`us-west1`); `gcloud builds list` without
`--region` won't show them.

**What the trigger does not protect you from.** The startup probe keeps a
revision that can't reach Postgres from taking traffic, but an app-level bug that
boots cleanly goes straight to production on merge. Until Block B1 lands the
severity mapping and Error Reporting alerting, nothing pages you — you find out
by looking. That is an argument for doing B1 soon, not for deploying by hand.

## 4. Service account & secrets (as built)

A **separate** SA from `course-worker`, but a **shared** DB secret: two secrets
holding the same pooler URL would give zero isolation (it is one Postgres role
either way) and two places to forget at rotation.

```bash
gcloud iam service-accounts create learning-app \
  --display-name="learning-app (Cloud Run service)" --project $PROJECT_ID
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member serviceAccount:$SA --role roles/aiplatform.user --condition=None
```

| Secret | Value | Who reads it |
| --- | --- | --- |
| `supabase-database-url` | Supabase **transaction** pooler, `:6543` | the app's runtime SA — and D4's `course-worker` SA |
| `supabase-session-url` | Supabase **session** pooler, `:5432` | Cloud Build only, for `migrate deploy` (§3a) |
| `youtube-api-key` | plain API key | the app's runtime SA |

Bindings go **on each secret**, never the project:

```bash
gcloud secrets add-iam-policy-binding <secret> --member serviceAccount:$SA \
  --role roles/secretmanager.secretAccessor --project $PROJECT_ID --condition=None
```

Two identity gotchas, both cost a build here:

- **Cloud Build runs as the compute default SA** (`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`),
  *not* the legacy `<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com` that the
  project IAM policy still lists with `cloudbuild.builds.builder`. Grant the
  compute SA. Confirm with `gcloud builds list --format='table(id,serviceAccount)'`.
  It carries `roles/editor`, which does **not** include Secret Manager access —
  basic roles deliberately exclude it — so the `secretAccessor` binding is
  required even though editor looks like it should cover everything. Narrowing
  builds to a dedicated least-privilege SA is worthwhile follow-up work.
- **Write secret values from a validated variable, never a hand-rolled `sed`.**
  BSD `sed` (macOS) doesn't support `\s`, so `sed -E 's/^#\s*NAME=//'` silently
  no-ops and you store the comment line instead of the URL. This produced a
  `supabase-database-url` whose value began `# SUPABASE_POOLER_URL="postgresql://…`
  and would have failed at runtime with `P1013: scheme is not recognized`.
  Check the scheme and port before writing:

  ```bash
  case "$VALUE" in postgresql://*:6543/*) ;; *) echo ABORT; exit 1;; esac
  ```

## 5. The service (as built)

Created by `cloudbuild.yaml`'s deploy step; the flags live there, repeated on
every build so the revision's shape is declared in the repo rather than
accumulated in console state.

```
learning-app  ·  us-west1  ·  1 vCPU / 512Mi  ·  min 0 / max 4
  SA        learning-app@learning-app-prod-mzw.iam.gserviceaccount.com
  env       GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION=us-central1
  secrets   DATABASE_URL=supabase-database-url:latest
            YOUTUBE_API_KEY=youtube-api-key:latest
  probe     startup httpGet /api/health?probe=db, period 5s, failureThreshold 6
  URL       https://learning-app-74223797331.us-west1.run.app
```

- **`--min-instances 0`** (changed 2026-07-30, was min 1): the original min-1
  rationale — "credits absorb the idle cost" — died with the credits. At beta
  traffic, request-based billing sits inside Cloud Run's always-free tier
  (180k vCPU-s / 360k GiB-s / 2M requests per month), so min 0 is ~$0/mo vs
  ~$50/mo idling. Cold start is ~3–5s (sub-second boot, `startup-cpu-boost`,
  plus the DB startup probe). Flip back to min 1 when there are paying users
  to shield from that first hit.
- **`--max-instances 4`**: 4 × the adapter-pg pool (10) = 40 client connections
  into the Supabase pooler, which D4's worker pool shares. `worker-deploy.md`
  §7 has the arithmetic; add both sides before raising either.
- The **startup probe accepts a query string** in `httpGet.path` — a booted
  server that can't reach Postgres never takes traffic.

### 5a. Verification (2026-07-29, revision `learning-app-00002-hjp`)

| Check | Result |
| --- | --- |
| `GET /` | 200, SSR, TTFB ~230ms |
| `GET /file.svg` | 200 — `public/` is served by the container (no CDN in front) |
| `GET /programs` anonymous | 307 → `/signin?next=%2Fprograms` |
| `GET /api/health?probe=db` | `{"ok":true,"db":"up"}` |
| `GET /api/health?probe=ai` as non-admin | plain liveness — admin gate holds |
| Google sign-in round-trip | lands signed in; `syncUser` wrote the first `User` row |
| `POST /api/generate-program` | **202**, `topicCount: 2` — decomposition ran, so **ADC → Vertex works in-cloud** |
| `/playground` → `/playground/dashboard` as signed-in non-admin | **404** (not 401/403 — non-enumerable, as designed) |
| Cloud Logging | structured lines arrive as `jsonPayload` with `event` + `traceId` |

`severity` is **empty** on those `jsonPayload` lines — Block B1's severity
mapping is what fills it, and this confirms B1 is still needed.

## 6. Domain mapping & OAuth cutover (D3 — DEFERRED)

> **Blocked: the custom domain is not yet acquired (2026-07-29).** D3 therefore
> lands the service on its `*.run.app` URL first. This section executes as a
> follow-up once the domain exists.

Sequence matters — Vercel must keep working until the new domain verifies:

- [ ] `gcloud beta run domain-mappings create --service learning-app --domain <domain>`
- [ ] Add the returned records at the registrar; wait for the cert to issue
- [ ] **Additively** add `https://<domain>/**` to Supabase → Authentication →
      URL Configuration → Redirect URLs, and the domain to the Google OAuth
      client's authorized origins/redirects. Do **not** remove the Vercel
      entries yet. **Use the `/**` wildcard, not a bare `/auth/callback`** —
      see the box below
- [ ] Flip Supabase's **Site URL** to the new domain
- [ ] Smoke on the new domain: Google sign-in round-trip, program creation
      returns 202, `/playground/*` 404s for a non-admin
- [ ] Only then: remove the Vercel redirect entries, and decommission Vercel
      (`vercel.json` — note its `buildCommand` is what has been running
      `prisma migrate deploy` against Supabase; **whatever replaces it must own
      migrations**, or the schema silently stops tracking `main`)
- [ ] No 301 grace period from the Vercel URL — there are no users or inbound
      links to preserve (Supabase `User` count was 0 at cutover planning)

> **Supabase matches the FULL redirect URL, query string included.** `/auth/login`
> builds `redirectTo` as `<origin>/auth/callback?next=%2F`, and a registered
> entry of `https://<host>/auth/callback` does **not** match it. Supabase does
> not error on a miss — it silently substitutes the project's **Site URL**, so
> the symptom is a successful Google sign-in that lands somewhere unrelated with
> a `?code=` on it. Measured on the `*.run.app` cutover: the exact-path entry
> failed, `https://<host>/**` worked.
>
> This is sharper than it looks because the **Site URL is currently
> `http://localhost:3000`**, so every allowlist miss strands the user on a dead
> address. Flipping it (a step above) is what makes a miss merely wrong rather
> than invisible. A durable alternative, if this bites again: move `next` out of
> the redirect URL into a short-lived cookie set by `/auth/login`, so
> `redirectTo` is a bare `…/auth/callback` that matches an exact entry.

> **The app must know its own public origin.** `src/lib/api/public-origin.ts`
> resolves it as `APP_ORIGIN` → `x-forwarded-host`/`-proto` → `Host` →
> `req.url`. Before D3 the three `/auth/*` routes built redirects from
> `new URL(req.url).origin`, which on Cloud Run is the container's bind address
> — sign-in bounced to `https://0.0.0.0:8080/auth/callback`. Vercel hid this by
> rewriting `req.url` to the public URL. Cloud Run sends `x-forwarded-host`, so
> **no `APP_ORIGIN` is needed** on either the `*.run.app` URL or a custom domain;
> set it only if a future proxy forwards something other than the public host.

## 7. Operations

| Task | Command |
| --- | --- |
| Ship a change (normal path) | the §3 `gcloud builds submit` — build + migrate + deploy |
| Redeploy an existing image | `gcloud run deploy learning-app --image $IMAGE:<tag> --region $REGION` |
| Roll back | same, previous known-good tag. **Check whether the bad revision migrated**: `migrate deploy` is forward-only, so rolling the image back does not roll the schema back |
| Scale to zero (pause) | `gcloud run services update learning-app --min-instances 0 --region $REGION` |
| Tail logs | `gcloud run services logs tail learning-app --region $REGION` |
| Rotate a runtime secret | `gcloud secrets versions add … --data-file=-`, then redeploy to restart (mounts read `latest` at boot) |
| Rotate the Supabase **anon key** | **rebuild the image** (§3) — it is inlined at build time |
| List revisions | `gcloud run revisions list --service learning-app --region $REGION` |

Structured logs (`src/lib/log.ts`) land in Cloud Logging as `jsonPayload`, same
as the worker; `worker-deploy.md` §10 has the filter patterns. Block B1 adds
the `severity` mapping and Error Reporting grouping on top.
