# Course-worker deploy — Cloud Run worker pools

How to take the containerized course worker (`Dockerfile.worker`, Workers
Block B) from local Docker Compose to **Google Cloud Run worker pools**. This
is the deferred cloud half of the concurrent-workers project: the local mode
(2 compose replicas against the local DB, `docker compose --profile workers up`)
is live today; follow this doc when it's time for always-on cloud workers
draining the production (Supabase) queue.

Everything below is idempotent-ish and incremental — you can stop after any
step and resume later. Commands assume the repo root as cwd.

## Prerequisites & starting state (verified 2026-07-13)

- `gcloud` SDK ≥ 569 installed and authed (`gcloud auth list`) against the
  Vertex project. `gcloud run worker-pools` exists at this version.
- **APIs**: only `aiplatform.googleapis.com` is enabled so far. Steps below
  enable Cloud Run, Artifact Registry, Secret Manager, and Cloud Build.
- **Vertex auth is ADC-ready**: `src/lib/ai/vertex.ts` falls back to
  Application Default Credentials when `GOOGLE_APPLICATION_CREDENTIALS_JSON`
  is unset (Block B). In-cloud, the worker authenticates as its runtime
  service account — **no key JSON goes in the image or the env**.
- **Billing awareness**: worker-pool instances are always-on. Ballpark
  ~$25–50/month per 1 vCPU + 1 GiB instance before GCP credits; two instances
  double that. Pausing = scale to 0 (step 8).

Shell variables used throughout (project/region come from `.env.local`):

```bash
export PROJECT_ID=$(grep -oE '^GOOGLE_VERTEX_PROJECT=.*' .env.local | cut -d= -f2)
export REGION=$(grep -oE '^GOOGLE_VERTEX_LOCATION=.*' .env.local | cut -d= -f2)  # us-central1
export REPO=learning-app          # Artifact Registry repo name
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/course-worker
export SA=course-worker@$PROJECT_ID.iam.gserviceaccount.com
```

## 1. Enable APIs (one-time)

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  --project $PROJECT_ID
```

## 2. Artifact Registry repo (one-time)

```bash
gcloud artifacts repositories create $REPO \
  --repository-format=docker --location=$REGION --project $PROJECT_ID
```

## 3. Build & push the image

**Path A — Cloud Build (recommended).** Builds server-side on amd64; no local
Docker involvement. `.dockerignore` keeps `.env*` out of the upload, but the
build context is still uploaded to a GCS bucket — the plan doc under `docs/`
is excluded too.

```bash
gcloud builds submit --project $PROJECT_ID \
  --tag $IMAGE:$(git rev-parse --short HEAD) \
  --timeout=15m .
```

⚠️ Cloud Build defaults to `Dockerfile` at the root; ours is
`Dockerfile.worker`. Either pass a one-line config:

```bash
gcloud builds submit --project $PROJECT_ID --config - . <<EOF
steps:
- name: gcr.io/cloud-builders/docker
  args: [build, -f, Dockerfile.worker, -t, "$IMAGE:\$SHORT_SHA", .]
images: ["$IMAGE:\$SHORT_SHA"]
EOF
```

**Path B — local build + push.** ⚠️ On Apple Silicon a plain `docker build`
produces an **arm64** image that Cloud Run cannot run — always cross-build:

```bash
gcloud auth configure-docker $REGION-docker.pkg.dev   # one-time
docker buildx build --platform linux/amd64 \
  -f Dockerfile.worker -t $IMAGE:$(git rev-parse --short HEAD) --push .
```

Tag with the git SHA (not just `latest`) so rollback (step 8) is a re-deploy
of a known-good tag.

## 4. DATABASE_URL into Secret Manager (one-time + rotations)

The value is the **Supabase transaction-pooler URL** (port 6543,
`?sslmode=require`) — the same string commented out in `.env.local`. Pipe it
in; don't put it on the command line (shell history):

```bash
printf '%s' 'postgresql://…pooler.supabase.com:6543/postgres?sslmode=require' |
  gcloud secrets create course-worker-database-url \
    --data-file=- --project $PROJECT_ID
```

Rotation = add a new version (`gcloud secrets versions add … --data-file=-`),
then restart instances (step 8, "update"); the pool reads `latest` at boot.

## 5. Dedicated service account (one-time)

```bash
gcloud iam service-accounts create course-worker \
  --display-name="course worker (Cloud Run pool)" --project $PROJECT_ID

# Vertex calls via ADC:
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member serviceAccount:$SA --role roles/aiplatform.user

# Read ONLY this secret (binding on the secret, not the project):
gcloud secrets add-iam-policy-binding course-worker-database-url \
  --member serviceAccount:$SA --role roles/secretmanager.secretAccessor \
  --project $PROJECT_ID
```

## 6. Create the worker pool

```bash
gcloud run worker-pools create course-worker \
  --project $PROJECT_ID --region $REGION \
  --image $IMAGE:<tag> \
  --instances 2 \
  --service-account $SA \
  --set-env-vars GOOGLE_VERTEX_PROJECT=$PROJECT_ID,GOOGLE_VERTEX_LOCATION=$REGION \
  --set-secrets DATABASE_URL=course-worker-database-url:latest \
  --memory 1Gi --cpu 1
```

Notes:

- **No `GOOGLE_APPLICATION_CREDENTIALS_JSON`** — its absence is what selects
  the ADC path. If Vertex calls fail with auth errors, check the pool is
  running as `$SA` (not the default compute SA) and that step 5's
  `aiplatform.user` binding exists.
- Optional env: `GOOGLE_VERTEX_ANTHROPIC_LOCATION` / `GOOGLE_VERTEX_GEMINI3_LOCATION`
  (both default `global`), `MODEL_EMBEDDING`, `YOUTUBE_API_KEY` (as a second
  secret if added; playlist decomposition is skipped when unset).
- **Termination grace**: the worker needs only ~6s after SIGTERM (A2 releases
  the in-flight claim in <1s; the idle loop exits within one 5s poll sleep).
  Cloud Run's default 10s grace is sufficient; if the create/update command
  at your SDK version exposes a termination-grace flag, set it anyway for
  headroom.
- **Worker identity**: the worker id is `CLOUD_RUN_INSTANCE_ID ?? hostname`
  + pid. Confirm in first logs that ids are distinct per instance (they will
  be even on the hostname fallback).
- **Fallback if worker pools are unavailable** on the account (locked
  decision D8): a Cloud Run **service** with
  `--no-allow-unauthenticated --min-instances=1 --max-instances=1 --ingress=internal`
  per instance needed, same env/secret/SA flags. Add a trivial HTTP liveness
  stub only if the platform refuses to start without a listening port.

## 7. DB connection math (check before raising instance count)

Each worker instance runs one Prisma client over `@prisma/adapter-pg`, whose
node-postgres pool defaults to **10 client connections max** (and stays near
0–2 in practice: the worker is one sequential pipeline, not a web server).

- 2 instances × 10 = worst-case 20 client connections into the Supabase
  **transaction pooler** (Supavisor, port 6543), which multiplexes them onto
  a much smaller set of real Postgres connections.
- Supabase's client-connection ceiling depends on plan/compute size (hundreds
  on the smallest tiers — check *Project Settings → Database → Connection
  pooling*). Keep `instances × 10` comfortably under it, remembering the
  Vercel app shares the same pooler.
- Scaling to N instances costs at most `N × 10` client connections; the
  binding constraint long-term is **Vertex quota** (each worker ≈ one
  concurrent LLM pipeline), not the DB — see the plan's Block D.

## 8. Operations

| Task | Command |
| --- | --- |
| Scale instance count | `gcloud run worker-pools update course-worker --region $REGION --instances N` |
| Pause (stop billing for instances) | same, `--instances 0` |
| Deploy a new image | `gcloud run worker-pools update course-worker --region $REGION --image $IMAGE:<new-tag>` |
| Roll back | same command with the previous known-good tag |
| Rotate DATABASE_URL | `gcloud secrets versions add course-worker-database-url --data-file=-`, then `update --image` (same tag) to restart instances |
| Tail logs | `gcloud beta run worker-pools logs tail course-worker --region $REGION` (or Logs Explorer) |
| Tear down | `worker-pools delete`, then optionally delete the secret/SA/repo |

**Reading a job's logs** (H3 structured JSON lands in Cloud Logging as
`jsonPayload`): filter by request id / worker —

```
resource.type="cloud_run_worker_pool"
jsonPayload.traceId="<courseRequestId>"        -- one job end-to-end
jsonPayload.event="course-request.requeued"    -- all requeues
jsonPayload.claimedBy=~"<instance id prefix>"  -- one instance's claims
```

## 9. Verification gate (from the concurrent-workers plan)

1. **Fulfill in-cloud**: enqueue a real request (the prod app, or a driver
   against the Supabase DB) and watch it fulfill via Cloud Logging;
   `claimedBy` should be a Cloud Run instance id. This is also the first live
   exercise of the **ADC auth path** — a Vertex auth failure here points at
   step 5/6, not the code.
2. **Instance death mid-job**: kill an instance mid-build (scale 2→1 while it
   holds a claim, or delete the instance). Expect the SIGTERM release
   (`course-worker.requeued-shutdown`) and pickup by the survivor within one
   poll cycle. A hard kill instead surfaces as stale-reclaim after 45m — the
   crash path, also fine.
3. **Deploy churn**: push a no-op revision (`update --image` same tag) while
   a job is in flight; confirm the graceful release keeps the request from
   waiting out the 45m stale window (the whole point of A2/D7).
4. Confirm both instances poll (two distinct worker ids in logs) and that the
   two-instance contention behavior matches the A2 local verification
   (same-topic cold builds: one builds, one requeues with backoff).

## 10. Observability & scaling (Workers Block D)

The code half already ships with the worker: every poll cycle each worker
emits a **queue-depth gauge** —

```json
{"event":"course-worker.queue-depth","queued":N,"running":N,"oldestQueuedAgeMs":N|null,"workerId":"…"}
```

`queued` includes backed-off rows (still backlog), `oldestQueuedAgeMs` ages
from `createdAt` (queue latency, not eligibility), `null` = empty queue. It
fires even at 0/0 so the metric has a heartbeat: **"no data" means "no
worker", not "no work"**. N workers emit N lines per cycle — aggregate with
max/percentile, never sum.

**Locally** (compose mode), each condition below is a `jq` filter away:

```bash
docker compose logs --no-log-prefix worker | jq -c 'select(.event=="course-worker.queue-depth")'
docker compose logs --no-log-prefix worker | jq -c 'select(.event=="course-request.reclaimed-stale")'
```

**At deploy time**, wire these as Cloud Logging **log-based metrics** +
alerting policies (all fields land in `jsonPayload`):

| Alert | Filter | Threshold / meaning |
| --- | --- | --- |
| Job deadline exceeded | `jsonPayload.event="course-worker.deadline-exceeded"` | count > 0 — a pipeline hit the 30m ceiling; look up its `traceId` |
| Zombie finish | `jsonPayload.event="course-request.finish-noop"` | count > 0 — a worker finished a request that had already been reclaimed; expected to be rare |
| Stale reclaims | `jsonPayload.event="course-request.reclaimed-stale"` | count > 0 — a worker died holding a claim (crash or SIGKILL past grace) |
| Contention spike | `jsonPayload.event="course-worker.requeued-contention"` | rate spike — many same-topic cold requests; usually benign backoff, but a sustained spike means the backoff budget (12 × 3m) is being spent |
| Queue depth | metric on `jsonPayload.queued` (gauge line) | sustained > ~5 — enqueue rate exceeds fleet throughput |
| Queue age | metric on `jsonPayload.oldestQueuedAgeMs` | sustained > ~10m — someone's build has been waiting; page-worthy once real users wait on builds |

**Scaling policy (manual, deliberate):** worker count tracks **Vertex quota
headroom, not CPU** — each worker is ≈ one concurrent LLM pipeline, so the
useful fleet size is `concurrent quota ÷ per-build burst`, and beyond that
extra instances just queue on Vertex instead of Postgres. When the queue-age
alert fires repeatedly, bump `--instances` (cloud) or `--scale worker=N`
(local) and watch the gauge drop; DB headroom per instance is the step-7
math. Genuine autoscaling on the queue-depth metric stays deferred until
real load exists.

## Relationship to local compose mode

Local mode (docker-compose.yml `workers` profile) and the cloud pool run the
**same image** and can coexist — but a laptop worker pointed at the
**production** DB is an anti-pattern: laptops suspend, which freezes the
30m job-deadline timer that the 45m stale-reclaim ordering depends on, and a
woken zombie re-opens the duplicate-build window (guards make it safe, not
free). Local containers stay on the local DB; the cloud pool owns the
production queue.
