#!/bin/bash
# COS startup script for the course-worker VM (free-beta Block D4).
#
# Attached at instance creation with
# `--metadata-from-file=startup-script=deploy/worker-vm-startup.sh` and re-run by
# COS on every boot, so `gcloud compute instances reset` is the deploy mechanism:
# this script re-reads the image tag from metadata and re-pulls. See
# worker-deploy.md §9.
#
# Written for Container-Optimized OS, which has docker and curl but NO gcloud,
# NO jq and NO python — hence the metadata-server REST calls and the sed/base64
# parsing below. Do not "simplify" these into gcloud commands.
#
# Instance metadata it reads (set at creation, editable afterwards with
# `gcloud compute instances add-metadata`):
#   worker-image   full image ref including tag, e.g.
#                  us-west1-docker.pkg.dev/<project>/learning-app/course-worker:abc1234
#   vertex-project GCP project id for Vertex (GOOGLE_VERTEX_PROJECT)
#   vertex-location Vertex region for Gemini <=2.5 (GOOGLE_VERTEX_LOCATION)

set -euo pipefail
# NEVER set -x: DATABASE_URL passes through this script, and the serial console
# log is readable by anyone with compute.instances.getSerialPortOutput.

MD='http://metadata.google.internal/computeMetadata/v1'
# $MD/instance/... for per-VM attributes, $MD/project/... for project ones.
MD_HEADER='Metadata-Flavor: Google'

meta() { curl -sf -H "$MD_HEADER" "$MD/instance/attributes/$1"; }

IMAGE=$(meta worker-image)
VERTEX_PROJECT=$(meta vertex-project)
VERTEX_LOCATION=$(meta vertex-location)
PROJECT_ID=$(curl -sf -H "$MD_HEADER" "$MD/project/project-id")
REGISTRY_HOST="${IMAGE%%/*}"

TOKEN=$(curl -sf -H "$MD_HEADER" \
  "$MD/instance/service-accounts/default/token" |
  sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
test -n "$TOKEN" || { echo "startup: no access token from metadata server"; exit 1; }

# Secret Manager REST rather than a mounted secret: a GCE VM has no equivalent of
# Cloud Run's --set-secrets, and putting the pooler URL in instance metadata
# instead would make it readable to anyone with compute.instances.get.
fetch_secret() {
  curl -sf -H "Authorization: Bearer $TOKEN" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT_ID/secrets/$1/versions/latest:access" |
    sed -n 's/.*"data": *"\([^"]*\)".*/\1/p' | base64 -d
}

# /run is tmpfs and root-only, so the URL never touches disk and never appears in
# `ps` output the way `docker run -e DATABASE_URL=...` would.
ENV_FILE=/run/course-worker.env
umask 077
{
  echo "DATABASE_URL=$(fetch_secret supabase-database-url)"
  echo "YOUTUBE_API_KEY=$(fetch_secret youtube-api-key)"
  echo "GOOGLE_VERTEX_PROJECT=$VERTEX_PROJECT"
  echo "GOOGLE_VERTEX_LOCATION=$VERTEX_LOCATION"
  # Absent GOOGLE_APPLICATION_CREDENTIALS_JSON is what selects the ADC path in
  # src/lib/ai/vertex.ts — the VM's service account. Do not add a key here.
} > "$ENV_FILE"
grep -q '^DATABASE_URL=postgres' "$ENV_FILE" ||
  { echo "startup: DATABASE_URL did not resolve to a postgres URL"; exit 1; }

# COS's root filesystem is READ-ONLY, so `docker login` cannot write its default
# /root/.docker/config.json — it fails with "mkdir /root/.docker: read-only file
# system" and, under `set -e`, kills this script before the pull. /var is one of
# the few writable paths. (systemd still reports the unit as status=0/SUCCESS,
# so the failure is invisible unless you read the journal.)
export DOCKER_CONFIG=/var/lib/course-worker-docker
mkdir -p "$DOCKER_CONFIG"

# --password-stdin, not -p: argv is world-readable via `ps` (see AGENTS.md,
# "Secrets: never let one transit your shell as a value").
printf '%s' "$TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://$REGISTRY_HOST"
docker pull "$IMAGE"
# The pull is the only thing that needs registry credentials; `docker run` does
# not. Drop the stored token rather than leave it on disk for its full hour.
rm -rf "$DOCKER_CONFIG"

docker rm -f course-worker 2>/dev/null || true

# --memory: 768m of the e2-micro's 1 GB, leaving COS its ~150 MB. The explicit
# NODE_OPTIONS heap cap (rather than letting Node size itself off the cgroup
# limit) keeps an out-of-memory failure a JS heap error with a stack instead of a
# silent docker SIGKILL. Either way the in-flight claim is only released by the
# 45m stale reclaim, so a repeat is the signal to move to an e2-small — §11.
# --stop-timeout: the worker needs ~6s to release its claim; docker's default 10s
# is enough but leaves no headroom on a shared-core VM.
docker run -d --name course-worker \
  --restart=always \
  --env-file "$ENV_FILE" \
  --log-driver=json-file --log-opt max-size=10m --log-opt max-file=3 \
  --memory=768m \
  -e NODE_OPTIONS=--max-old-space-size=512 \
  --stop-timeout=30 \
  "$IMAGE"

# The container has the env; the file has done its job. Keeping it would leave
# the URL readable for the life of the boot.
shred -u "$ENV_FILE" 2>/dev/null || rm -f "$ENV_FILE"
