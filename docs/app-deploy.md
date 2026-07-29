# App deploy — Cloud Run service

How to take the containerized Next.js app (`Dockerfile`, free-beta Block D1)
from a local Docker run to a **Google Cloud Run service**, and cut Vercel over
to it. Companion to [`worker-deploy.md`](worker-deploy.md), which covers the
worker-pool half of the same migration; the two share a GCP project, an
Artifact Registry repo, and the Supabase database.

> **Status: D1 complete, D3 not yet executed.** The image builds and runs
> locally (verification below). Everything from §3 on is the D3 runbook and is
> written but **unexecuted** — treat the commands as reviewed-not-verified until
> D3 stamps them, the way worker-deploy.md is stamped "verified 2026-07-13".

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
| `DEV_AUTH` / `TRACE_RESPONSE` | — | **never set in cloud.** `DEV_AUTH` is inert anyway (Next's standalone server hardcodes `NODE_ENV=production`); `TRACE_RESPONSE` leaks pipeline internals |

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
export PROJECT_ID=$(grep -oE '^GOOGLE_VERTEX_PROJECT=.*' .env.local | cut -d= -f2)
export REGION=$(grep -oE '^GOOGLE_VERTEX_LOCATION=.*' .env.local | cut -d= -f2)  # us-central1
export REPO=learning-app
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/learning-app
export SA=learning-app@$PROJECT_ID.iam.gserviceaccount.com
```

## 3. Build & push (D3 — TODO)

Cloud Build, for the same reason as the worker (server-side amd64; a plain
`docker build` on Apple Silicon produces an arm64 image Cloud Run can't run).
Unlike the worker, **the app's Dockerfile is the default `Dockerfile`**, so no
`-f` config is needed — but the two `NEXT_PUBLIC_*` build args are, which means
a `--config` build with substitutions rather than a bare `--tag` submit.

- [ ] Write the `cloudbuild` inline config with `--build-arg` for both `NEXT_PUBLIC_*`
- [ ] Tag with the git SHA (not `latest`) so rollback is a re-deploy of a known tag
- [ ] Confirm `.dockerignore` still excludes `.env*` (the context uploads to GCS)

## 4. Service account & secrets (D3 — TODO)

A **separate** SA from `course-worker` — same Vertex role, but the app also
needs its own `DATABASE_URL` secret binding. Least privilege means not sharing
the worker's identity.

- [ ] `gcloud iam service-accounts create learning-app`
- [ ] `roles/aiplatform.user` on the project (ADC → Vertex)
- [ ] `roles/secretmanager.secretAccessor` **on each secret**, not the project
- [ ] Reuse the existing `course-worker-database-url` secret, or mint an
      app-scoped one — decide at deploy; sharing is simpler, separate rotation
      is safer
- [ ] `YOUTUBE_API_KEY` as a second secret

## 5. Create the service (D3 — TODO)

```
gcloud run deploy learning-app \
  --image $IMAGE:<tag> --region $REGION --service-account $SA \
  --allow-unauthenticated --port 8080 --cpu 1 --memory 512Mi \
  --min-instances 1 --max-instances <N> \
  --set-env-vars GOOGLE_VERTEX_PROJECT=$PROJECT_ID,GOOGLE_VERTEX_LOCATION=$REGION \
  --set-secrets DATABASE_URL=…:latest,YOUTUBE_API_KEY=…:latest
```

- **`--min-instances 1`** (locked): a cold start in front of a beta user's
  first impression isn't worth the saving, and GCP credits absorb it.
- **Startup probe** on `/api/health?probe=db` — a booted server that can't
  reach Postgres should not take traffic.
- **DB connections:** the app's pool shares the Supabase transaction pooler
  with the worker pool. `worker-deploy.md` §7 has the arithmetic; add the app's
  `max-instances × pool size` to it before raising either.

## 6. Domain mapping & OAuth cutover (D3 — DEFERRED)

> **Blocked: the custom domain is not yet acquired (2026-07-29).** D3 therefore
> lands the service on its `*.run.app` URL first. This section executes as a
> follow-up once the domain exists.

Sequence matters — Vercel must keep working until the new domain verifies:

- [ ] `gcloud beta run domain-mappings create --service learning-app --domain <domain>`
- [ ] Add the returned records at the registrar; wait for the cert to issue
- [ ] **Additively** add `https://<domain>/auth/callback` to Supabase →
      Authentication → URL Configuration → Redirect URLs, and the domain to the
      Google OAuth client's authorized origins/redirects. Do **not** remove the
      Vercel entries yet
- [ ] Flip Supabase's **Site URL** to the new domain
- [ ] Smoke on the new domain: Google sign-in round-trip, program creation
      returns 202, `/playground/*` 404s for a non-admin
- [ ] Only then: remove the Vercel redirect entries, and decommission Vercel
      (`vercel.json` — note its `buildCommand` is what has been running
      `prisma migrate deploy` against Supabase; **whatever replaces it must own
      migrations**, or the schema silently stops tracking `main`)
- [ ] No 301 grace period from the Vercel URL — there are no users or inbound
      links to preserve (Supabase `User` count was 0 at cutover planning)

## 7. Operations (D3 — TODO)

| Task | Command |
| --- | --- |
| Deploy a new image | `gcloud run deploy learning-app --image $IMAGE:<new-tag> --region $REGION` |
| Roll back | same, previous known-good tag |
| Scale to zero (pause) | `gcloud run services update learning-app --min-instances 0 --region $REGION` |
| Tail logs | `gcloud run services logs tail learning-app --region $REGION` |
| Rotate a secret | `gcloud secrets versions add … --data-file=-`, then redeploy to restart |
| Rotate the Supabase **anon key** | **rebuild the image** (§3) — it is inlined at build time |

Structured logs (`src/lib/log.ts`) land in Cloud Logging as `jsonPayload`, same
as the worker; `worker-deploy.md` §10 has the filter patterns. Block B1 adds
the `severity` mapping and Error Reporting grouping on top.
