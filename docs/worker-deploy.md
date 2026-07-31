# Course-worker deploy — GCE `e2-micro` (Container-Optimized OS)

How to run the containerized course worker (`Dockerfile.worker`, Workers Block B)
in production: **one always-on `e2-micro` VM in `us-west1`**, running the same
image the local `docker compose --profile workers` mode runs. This is free-beta
Block D4.

Local mode (2 compose replicas against the local Docker Postgres) is unchanged
and stays for development. The cloud worker owns the **production** queue.

Everything below is idempotent-ish and incremental — you can stop after any step
and resume later. Commands assume the repo root as cwd.

## 0. Why a VM and not a Cloud Run worker pool

This runbook used to target Cloud Run worker pools. It doesn't any more, and the
reason is structural rather than a preference: **the worker polls the database,
so it can never scale to zero.** On Cloud Run that means paying for an
always-allocated instance around the clock.

| Host | Cost/month | Note |
| --- | --- | --- |
| Cloud Run worker pool, 1 instance (1 vCPU / 1 GiB) | ~$25–50 | always-allocated; no idle discount for a polling loop |
| `e2-micro` + 30 GB standard PD, `us-west1` | **$0** | Always Free tier — 1 non-preemptible instance/month |
| External IPv4 on that VM | **~$2.92** | $0.004/hr, **not** covered by the free tier |
| Egress beyond the free 1 GB/mo NA | cents | ~$0.12/GB; DB + Vertex chatter |

So ~$3/month against ~$50. That mattered once the GCP credits lapsed
(2026-07-30); it is the same reason the app service dropped to `min-instances=0`.

The external IP is unavoidable: Private Google Access would cover Vertex and
Artifact Registry for free, but **Supabase is on AWS**, so the worker needs real
internet egress. Cloud NAT is the alternative and costs an order of magnitude
more than the address.

`us-west1` is both a free-tier region and the region the worker wants anyway — it
tracks the **database** (Supabase is `aws-1-us-west-1`), because the worker is far
more DB-chatty than Vertex-chatty. The app service is there for the same reason.
**`REGION` is not `GOOGLE_VERTEX_LOCATION`**: that one says where the models are
served and stays `us-central1`.

> ⚠️ **The worker is currently in `us-central1-a`, and that is a workaround, not a
> decision.** On 2026-07-31 `e2-micro` capacity was exhausted in **all three**
> `us-west1` zones (`resource_availability`, confirmed not quota — E2_CPUS limit
> 100, usage 0). `us-central1` is also Always Free, so the cost is identical bar
> ~$0.01/mo of cross-region image pulls; the trade is purely leaving the database's
> region, and the latency cost is **unmeasured**.
>
> **Move it back to `us-west1` when capacity returns.** Retry the §6 create in a
> `us-west1` zone; if it succeeds, verify (§11) and delete the `us-central1`
> instance. The VM is stateless — all state is in Supabase — so this is a
> ten-minute swap with no data movement. The one thing that would make it
> expensive is anything keyed to the worker's **egress IP** (currently
> `104.197.62.19`), e.g. Supabase network restrictions; there is nothing today.
> Do not read the current region as precedent for placing new components.

The Cloud Run worker-pool path is preserved in §13 as the scale-up route, for
when queue depth genuinely needs more than one worker.

## Prerequisites & starting state (verified 2026-07-31)

- `gcloud` SDK ≥ 569, authed against the Vertex project.
- APIs enabled: `aiplatform`, `run`, `artifactregistry`, `secretmanager`,
  `cloudbuild`, `logging`, and — added by D4 — `compute`.
- **Vertex auth is ADC-ready**: `src/lib/ai/vertex.ts` falls back to Application
  Default Credentials when `GOOGLE_APPLICATION_CREDENTIALS_JSON` is unset. In
  cloud the worker authenticates as its VM service account — **no key JSON goes
  in the image, the metadata, or the env**.

```bash
export PROJECT_ID=$(grep -oE '^GOOGLE_VERTEX_PROJECT=.*' .env.local | cut -d= -f2)
export REGION=us-west1
export ZONE=us-west1-b
export VERTEX_LOCATION=us-central1
export REPO=learning-app
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/course-worker
export SA=course-worker@$PROJECT_ID.iam.gserviceaccount.com
export INSTANCE=course-worker
```

## 1. Enable APIs (one-time)

```bash
gcloud services enable compute.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com logging.googleapis.com --project $PROJECT_ID
```

> Done 2026-07-31 (`compute` was the only one missing).

## 2. Artifact Registry repo (one-time)

> Already exists — D3 created `learning-app` in `us-west1` for the app image.
> The worker image is a second image in the same repo.

```bash
gcloud artifacts repositories create $REPO \
  --repository-format=docker --location=$REGION --project $PROJECT_ID
```

## 3. Build & push the image

```bash
gcloud builds submit --project $PROJECT_ID \
  --config cloudbuild.worker.yaml \
  --substitutions=_TAG=$(git rev-parse --short HEAD) .
```

`cloudbuild.worker.yaml` exists because Cloud Build defaults to `Dockerfile` at
the root and ours is `Dockerfile.worker`. It builds server-side on **amd64** — a
plain `docker build` on Apple Silicon produces an arm64 image the `e2-micro`
cannot run.

Tag with the git SHA, never just `latest`: the VM's metadata names an exact tag,
and rollback (§10) is re-pointing it at a known-good one.

## 4. `DATABASE_URL` in Secret Manager

> Already done by D3 (2026-07-29). The secret is **`supabase-database-url`**,
> shared with the Cloud Run app service — two secrets holding the same pooler URL
> would be one Postgres role either way, so sharing costs no isolation and
> removes a rotation you can forget. `app-deploy.md` §4 has the full inventory.

The value is the Supabase **transaction-pooler** URL (port 6543,
`?sslmode=require`). Rotation = add a version, then restart the VM (§10).

## 5. Service account

> Created 2026-07-31.

```bash
gcloud iam service-accounts create course-worker \
  --display-name="course worker (GCE e2-micro)" --project $PROJECT_ID
```

| Role | Why |
| --- | --- |
| `roles/aiplatform.user` | Vertex calls via ADC |
| `roles/artifactregistry.reader` | pull the worker image |
| `roles/logging.logWriter` | **the VM's logs do not reach Cloud Logging without this** — see §12 |
| `roles/monitoring.metricWriter` | VM metrics |
| `roles/secretmanager.secretAccessor` on `supabase-database-url` and `youtube-api-key` | granted on the secrets, not the project |

## 6. Create the VM

```bash
gcloud compute instances create $INSTANCE \
  --project $PROJECT_ID --zone $ZONE \
  --machine-type=e2-micro \
  --image-family=cos-129-lts --image-project=cos-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --service-account=$SA \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --metadata=google-logging-enabled=true,worker-image=$IMAGE:<tag>,vertex-project=$PROJECT_ID,vertex-location=$VERTEX_LOCATION \
  --metadata-from-file=startup-script=deploy/worker-vm-startup.sh
```

Each flag is load-bearing:

- **`cos-129-lts`, not `cos-arm64-*`** — `e2-micro` is x86_64. The arm64 families
  sort adjacently in `gcloud compute images list` and are easy to grab by mistake.
- **`--scopes=cloud-platform`** — the VM's *IAM roles* are what actually authorize
  it, but the legacy scope on the instance still caps what the metadata token can
  request. Without this the startup script's Secret Manager call fails with a
  403 that reads like a missing IAM binding and isn't.
- **`google-logging-enabled=true`** — COS ships a fluent-bit agent that forwards
  container stdout to Cloud Logging, and it is **off by default**. On Cloud Run
  this was free; here, forgetting it means a worker that runs fine and is
  completely unobservable. See §12.
- **`--metadata=worker-image=…:<tag>`** — the deploy pointer, read by the startup
  script on every boot (§9).
- **30 GB `pd-standard`** — exactly the Always Free disk allowance. A larger disk,
  or `pd-balanced`, leaves the free tier.

`deploy/worker-vm-startup.sh` is tracked in the repo. It fetches the secrets from
Secret Manager via the metadata token, writes them to a root-only file on `/run`
(tmpfs — so the pooler URL never touches disk and never appears in `ps`), then
`docker run`s the image with `--restart=always`. It re-runs on every boot, which
is what makes §9's deploy work.

Secrets deliberately do **not** go in instance metadata: a GCE VM has no
equivalent of Cloud Run's `--set-secrets`, and metadata is readable by anyone
holding `compute.instances.get`.

## 7. Memory headroom — measured

`e2-micro` has **1 GB of RAM**, which was the one real risk in choosing it. It was
measured rather than assumed, against the local compose worker on 2026-07-31:

| Scenario | Peak RSS |
| --- | --- |
| Idle (polling only) | 229 MiB |
| Warm build — `calculus`, 0 spine holes, 444-resource library, no web sourcing (fulfilled in 216s) | **253 MiB** |
| Cold build — `data-structures-algorithms`, no Path, spine authoring + sourcing ladder + track build (fulfilled in 1346s) | **273 MiB** |

The worker is one sequential pipeline that streams model responses and writes
rows, so it does not accumulate a large working set: a 22-minute cold build costs
**44 MiB over idle**, not a multiple of it. Peak plus COS's ~150 MiB is under half
the ~960 MiB usable, so 1 GB is comfortable rather than marginal.

Re-measure with the same method if the pipeline ever starts holding whole
documents in memory (bulk embedding, PDF parsing) — that is the change that would
invalidate this, not build duration.

The startup script still caps the container at `--memory=768m` with
`NODE_OPTIONS=--max-old-space-size=512` — roughly 3× observed peak. The cap is
there so that if something does blow up, it fails as a JS heap error with a stack
rather than a silent kernel OOM kill.

**When to escalate.** Either failure mode kills the process without the graceful
claim release, so the in-flight request waits out the 45-minute stale reclaim
(§11). One occurrence is a bad day; a repeat means the workload changed — move to
`e2-small` (2 GB, ~$13/mo, leaves the free tier):

```bash
gcloud compute instances stop $INSTANCE --zone $ZONE --project $PROJECT_ID
gcloud compute instances set-machine-type $INSTANCE --zone $ZONE \
  --machine-type=e2-small --project $PROJECT_ID
gcloud compute instances start $INSTANCE --zone $ZONE --project $PROJECT_ID
```

Then raise `--memory` in `deploy/worker-vm-startup.sh` to match.

## 8. DB connection math (check before adding workers)

Each worker runs one Prisma client over `@prisma/adapter-pg`, whose node-postgres
pool defaults to **10 connections max** (and sits near 0–2 in practice — the
worker is one sequential pipeline, not a web server).

- 1 VM × 10 = worst-case 10 client connections into the Supabase transaction
  pooler (Supavisor, 6543), which multiplexes them onto far fewer real ones.
- The app service shares that pooler: `max-instances=4` × 10 = 40. Count both
  sides before raising either.
- Long-term the binding constraint is **Vertex quota**, not the DB — each worker
  is ≈ one concurrent LLM pipeline.

## 9. Deploying a new worker image

**The worker does not auto-deploy.** The app service rebuilds and deploys on every
merge to `main` via the `deploy-main` Cloud Build trigger; the worker does not. A
merge that changes worker code changes **nothing in production** until you run
this. That asymmetry is deliberate (see `cloudbuild.worker.yaml`'s header) but it
is the single easiest thing to forget in this runbook.

```bash
# 1. build & push the new tag (§3)
gcloud builds submit --project $PROJECT_ID --config cloudbuild.worker.yaml \
  --substitutions=_TAG=$(git rev-parse --short HEAD) .

# 2. point the VM at it
gcloud compute instances add-metadata $INSTANCE --zone $ZONE --project $PROJECT_ID \
  --metadata=worker-image=$IMAGE:$(git rev-parse --short HEAD)

# 3. re-run the startup script
gcloud compute instances reset $INSTANCE --zone $ZONE --project $PROJECT_ID
```

⚠️ **`reset` is a hard power cycle, not a graceful restart** — it does not send
SIGTERM, so an in-flight claim is not released and waits out the 45-minute stale
reclaim. Check the queue is idle first (§12's queue-depth gauge), or accept the
delay. For a graceful swap, SSH in and `docker stop course-worker` (the container
has a 30s stop timeout; the worker releases its claim in ~1s) before resetting.

Rollback is the same three steps with the previous tag.

## 10. Operations

| Task | Command |
| --- | --- |
| Tail worker logs | `gcloud compute ssh $INSTANCE --zone $ZONE -- docker logs -f course-worker` |
| Pause the worker | `gcloud compute instances stop $INSTANCE --zone $ZONE` |
| Resume | `gcloud compute instances start $INSTANCE --zone $ZONE` (startup script re-runs, re-pulls) |
| Graceful container restart | `gcloud compute ssh $INSTANCE --zone $ZONE -- docker restart -t 30 course-worker` |
| Deploy / roll back | §9 |
| Rotate `DATABASE_URL` | `gcloud secrets versions add supabase-database-url --data-file=-`, then §9 step 3 |
| Tear down | `gcloud compute instances delete $INSTANCE --zone $ZONE` |

Stopping the VM stops the instance charge but **not** the disk charge; the 30 GB
is inside the free tier either way.

## 11. Verification gate

1. **Fulfill in-cloud**: enqueue a real request from the deployed app and watch it
   fulfill in Cloud Logging; `claimedBy` should be the VM's hostname + pid. This
   is also the first live exercise of the **ADC auth path** — a Vertex auth
   failure here points at §5/§6, not the code.
2. **Structured logs survive the hop** (new in D4, and the one thing Cloud Run
   gave for free): confirm entries arrive with `jsonPayload.event` populated and
   `severity` respected — not as flat `textPayload` strings. B1's worker error
   reporting depends on it. See §12.
3. **Graceful shutdown**: `docker stop -t 30 course-worker` mid-build → expect
   `course-worker.requeued-shutdown` and the claim released within ~1s.
4. **Crash path**: `gcloud compute instances reset` mid-build → no graceful
   release; the request returns via stale reclaim after 45m. Confirm it does.
5. **Reboot resilience**: `stop` then `start`; the startup script must re-pull and
   the worker must resume polling with no manual step.

### Verified in production (2026-07-31, `course-worker` in `us-central1-a`)

| # | Result |
| --- | --- |
| 1 | ✅ Drained a real 47-hour-old backlog: `linear-algebra` 13m41s / 22 lessons, `machine-learning` 13m15s / 13 lessons. `claimedBy` was the container hostname + pid. **The ADC path works** — both builds made live Vertex calls with no key in the image. |
| 2 | ✅ COS fluent-bit **does** parse the JSON: `severity` and `jsonPayload.event/queued/workerId` arrive as structured fields, not `textPayload`. This was undocumented going in, and B1's worker error reporting depends on it. |
| 3 | ✅ `docker stop -t 30` **while holding a claim**: released in **1s**, exit 0, `course-worker.requeued-shutdown` with `requeued:true, failedAtCap:false` and `course-request.requeued` at `delayMs:0`. The row returned to `queued` with `claimedAt` cleared and no backoff, and the restarted worker re-claimed it within a second. Also confirms `node --import tsx` keeps node as PID 1 — under `npx`, npm's `sh -c` wrapper swallows SIGTERM and the release never runs. |
| 4 | ✅ `instances reset` **while holding a claim** (no SIGTERM): VM back in 28s, row still `running` under the dead container id. `course-request.reclaimed-stale` fired at **exactly `claimedAt + 45m00s`**, matching `COURSE_REQUEST_STALE_MS`, and the new container re-claimed it 1s later (`attempts=3`) and re-ran the whole pipeline. Note the sweep runs on the **rebooted** worker — it does not depend on the process that died. |
| 5 | ✅ `instances reset` → **13s** to a polling worker. `startup-script exit status 0` on a real boot (not just a hand-invoked `google_metadata_script_runner`), image served from the local cache, `restarts=0`, and `DOCKER_CONFIG` cleaned up. |

Memory in production tracked the local measurements: 168 MiB shortly after boot
against the 768m cap, `OOMKilled=false` throughout.

**Step 4's rebuild ended `failed`, and that is not a host problem** — worth stating
because the row reads as a pass sitting next to a failure. The recovered
`precalculus` request re-ran cleanly (fresh spine authored 12:31:08–12:31:37, so
nothing survived from the two killed attempts) and then failed with
`spine holes left uncoverable`: **one** of the 13 spine concepts had no candidate
resource. That is a **curation** outcome, and C2's job. What step 4 tests is that
a dead worker's claim is recovered and re-executed to a correct terminal state —
including correctly recording a failure.

When reading a hole count, filter on `membership: spine` — `recomputeReadiness`
does (`recompute-readiness.ts:41`), and frontier concepts routinely have no
resource by design. Counting all concepts made this look like four holes and sent
one investigation down a false trail.

**One benign log line to expect on every boot**, so nobody chases it: the metadata
script runner emits a 404 for `instance/attributes/created-by`, an attribute only
managed instance groups set. Harmless.

## 12. Observability

Every poll cycle the worker emits a **queue-depth gauge**:

```json
{"event":"course-worker.queue-depth","queued":N,"running":N,"oldestQueuedAgeMs":N|null,"workerId":"…"}
```

`queued` includes backed-off rows (still backlog), `oldestQueuedAgeMs` ages from
`createdAt`, `null` = empty queue. It fires even at 0/0 so the metric has a
heartbeat: **"no data" means "no worker", not "no work"**.

**Locally** (compose mode):

```bash
docker compose logs --no-log-prefix worker | jq -c 'select(.event=="course-worker.queue-depth")'
```

**In cloud** — note the resource type changed with the host. Worker logs are now
`gce_instance`, not `cloud_run_worker_pool`:

```
resource.type="gce_instance"
resource.labels.instance_id="<id>"
jsonPayload.traceId="<courseRequestId>"     -- one job end-to-end
jsonPayload.event="course-request.requeued" -- all requeues
```

The worker also sets `LOG_SERVICE_NAME=course-worker` (baked into
`Dockerfile.worker`, free-beta B1) so its errors group separately from the app's
in Error Reporting — Cloud Run injects `K_SERVICE` for the app service, and a
plain container has none.

⚠️ **Never alert on bare `resource.type="gce_instance" AND severity>=ERROR`.**
That filter also matches **Cloud Audit Logs**, which record every *failed Compute
API call* at ERROR severity against the same resource type — a rejected
`instances create`, a permission denial, a quota refusal. Observed live during
D4: ten ERROR entries that were the audit trail of failed `us-west1` create
attempts, with empty payloads and no relation to the worker. Scope the filter to
the container log stream, which only the worker writes to:

```
resource.type="gce_instance"
logName:"logs/cos_containers"
severity>="ERROR"
```

The `cos_system` stream is also noisy at ERROR on a healthy boot (COS's cloud-init
emits `Failed to wait for network. No network activator found` every time), which
is a second reason to scope by log name rather than resource type.

| Alert | Filter | Meaning |
| --- | --- | --- |
| Job deadline exceeded | `jsonPayload.event="course-worker.deadline-exceeded"` | a pipeline hit the 30m ceiling; look up its `traceId` |
| Zombie finish | `jsonPayload.event="course-request.finish-noop"` | finished a request already reclaimed; should be rare |
| Stale reclaims | `jsonPayload.event="course-request.reclaimed-stale"` | a worker died holding a claim — on this host, usually a `reset` or an OOM (§7) |
| Contention spike | `jsonPayload.event="course-worker.requeued-contention"` | many same-topic cold requests; benign backoff unless sustained |
| Queue depth | metric on `jsonPayload.queued` | sustained > ~5 — enqueue rate exceeds throughput |
| Queue age | metric on `jsonPayload.oldestQueuedAgeMs` | sustained > ~10m — someone's build is waiting |

**Worker liveness is now your problem.** Cloud Run restarted a dead instance;
here, `--restart=always` covers a crashed container and the VM covers a reboot,
but nothing covers a wedged VM. The queue-depth heartbeat is the check that
catches it — alert on its *absence*, not just its value.

## 13. If you need more than one worker — the Cloud Run worker-pool path

Scaling policy is deliberate and manual: worker count tracks **Vertex quota
headroom, not CPU**. Beyond `concurrent quota ÷ per-build burst`, extra workers
queue on Vertex instead of Postgres. When the queue-age alert fires repeatedly
and one worker is genuinely saturated — which is also roughly when revenue
exists — move to a Cloud Run worker pool rather than a second VM:

```bash
gcloud run worker-pools create course-worker \
  --project $PROJECT_ID --region $REGION \
  --image $IMAGE:<tag> --instances 2 --service-account $SA \
  --set-env-vars GOOGLE_VERTEX_PROJECT=$PROJECT_ID,GOOGLE_VERTEX_LOCATION=$VERTEX_LOCATION \
  --set-secrets DATABASE_URL=supabase-database-url:latest,YOUTUBE_API_KEY=youtube-api-key:latest \
  --memory 1Gi --cpu 1
```

The image, service account, and secret wiring above all carry over unchanged —
only the host differs. Log filters go back to
`resource.type="cloud_run_worker_pool"`, and `CLOUD_RUN_INSTANCE_ID` starts
populating the worker id instead of the hostname fallback.

**Fallback if worker pools are unavailable** on the account: a Cloud Run
**service** per instance with `--no-allow-unauthenticated --min-instances=1
--max-instances=1 --ingress=internal`, same env/secret/SA flags.

## Relationship to local compose mode

Local mode (`docker-compose.yml`'s `workers` profile) and the cloud worker run the
**same image** and can coexist — but a laptop worker pointed at the **production**
DB is an anti-pattern: laptops suspend, which freezes the 30m job-deadline timer
that the 45m stale-reclaim ordering depends on, and a woken zombie re-opens the
duplicate-build window (the guards make it safe, not free). Local containers stay
on the local DB; the VM owns the production queue.

Before `npm run test:int`, stop the compose workers — they poll the same local DB
and steal the tests' queue rows (`docker compose --profile workers stop worker`).
