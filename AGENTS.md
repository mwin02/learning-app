<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hosting — where things actually run

**Google Cloud is where production runs** (free-beta blocks D1–D4, 2026-07-29 → 07-31). Compute is GCP, data stays Supabase. **Vercel is fully decommissioned as of 2026-07-31** — project deleted, Git integration disconnected, env vars removed, and its URLs taken out of the Supabase Auth allowlist and the Google OAuth client. `vercel.json` is deleted. There is no second deployment target.

| Component | Where | Deploys how |
| --- | --- | --- |
| Next.js app | Cloud Run service `learning-app`, `us-west1`, `min-instances=0` | **automatic** on every merge to `main` (`deploy-main` Cloud Build trigger → `cloudbuild.yaml`) |
| Course worker | GCE `e2-micro` on Container-Optimized OS, `us-central1-a` | **manual**: build → `add-metadata worker-image=…` → `instances reset` (`worker-deploy.md` §9) |
| DB + auth | Supabase, `aws-1-us-west-1` | — |
| Migrations | a step inside `cloudbuild.yaml`, before the deploy | with the app |

Three consequences worth carrying:

- **The worker does not auto-deploy.** A merge that changes worker code changes nothing in production until someone runs `worker-deploy.md` §9. The app and the worker share `src/lib`, so this asymmetry is easy to forget.
- **`next.config.ts`'s `output: 'standalone'` is now load-bearing**, not a hedge — the `Dockerfile` copies `.next/standalone/`. Removing it breaks the image.
- **Avoid provider-only primitives** for the same reason as before, now pointed at GCP: prefer things that would survive another move. Raise it in discussion before reaching for one.

The app has **no custom domain yet** (`app-deploy.md` §6 is deferred), so its public origin is the Cloud Run URL `https://learning-app-sau6bxtxta-uw.a.run.app`. That string is hardcoded in one place — the crawler User-Agent in `src/lib/agents/decomposition/doctoc.ts`, which is the contact URL site owners see in their logs — so it must move when the domain lands. Everywhere else derives the origin at runtime (`src/lib/api/public-origin.ts`, `APP_ORIGIN` first).

`@vercel/oidc` in `package-lock.json` is transitive via `ai` → `@ai-sdk/gateway`. Not ours, not removable, not a leftover.

# Migrations: never drop the hand-written indexes Prisma can't model

Some indexes are created in raw SQL inside a migration because Prisma's schema language can't express them. Prisma has no idea they exist, so **every** subsequent `prisma migrate dev` reads each one as drift and prepends a `DROP INDEX` for it to the new migration. Dropping any of them is wrong. There are currently **two**:

| Index | Table | Why Prisma can't model it | What it does — why dropping it breaks things |
| --- | --- | --- | --- |
| `Resource_embedding_idx` | `Resource` | hnsw index over the `Unsupported("vector(768)")` `embedding` column (AR-1 migration) | the pgvector semantic-search index `searchResources` depends on |
| `RemediationJob_active_per_path` | `RemediationJob` | **partial** unique index (`... WHERE state IN ('queued','running')`); Prisma can't express partial indexes (2.5f-1 migration) | the single-flight backstop for spine-hole remediation — without it, concurrent claims stop conflicting and a Path can run two remediation jobs at once |

**Every time you generate a migration:**
1. Open the generated `migration.sql` and **delete any `DROP INDEX` line for the indexes in the table above** (and its `-- DropIndex` comment). Leave a short note in the file explaining why, as `20260602145709_topic_alias_registry` and `20260611121438_phase_2_5e_track_target_mastery` do.
2. If you already ran `migrate dev` before noticing (it applies the drop immediately), the index is now gone from your local DB — recreate it:
   - `Resource_embedding_idx`: `CREATE INDEX IF NOT EXISTS "Resource_embedding_idx" ON "Resource" USING hnsw ("embedding" vector_cosine_ops);`
   - `RemediationJob_active_per_path`: `CREATE UNIQUE INDEX IF NOT EXISTS "RemediationJob_active_per_path" ON "RemediationJob"("pathId") WHERE "state" IN ('queued', 'running');`
   and reconcile the recorded checksum (`migrate dev` stored the hash of the un-edited file): update `_prisma_migrations.checksum` for that migration to the sha256 of the corrected file, or `migrate status` / a later `migrate dev` will flag it as modified-after-apply.
3. Confirm the index is back — e.g. `SELECT indexname FROM pg_indexes WHERE indexname IN ('Resource_embedding_idx', 'RemediationJob_active_per_path');` — before moving on.

Editing the `migration.sql` *before* the first apply avoids steps 2–3 entirely — check the diff the moment it's generated.

# Secrets: never let one transit your shell as a value

Both of this repo's real leaks (2026-07-31, same session) were caused by shell that printed a secret **as a side effect** — not by anyone deliberately echoing one. Neither looked dangerous while being typed:

| What was run | What happened |
| --- | --- |
| `echo "set: ${YOUTUBE_API_KEY:+yes}${YOUTUBE_API_KEY:-NO}"` | `${VAR:-default}` expands to **the value** when the variable is set. Intended as a presence check; printed the key. |
| `export $(grep '^SUPABASE_POOLER_URL=' .env.local \| sed "s/'//g")` then a `tsx` run | Stray quotes survived, Node rejected the URL, and `ERR_INVALID_URL` **echoes its input** — printing the production Postgres password. |

The transferable lesson is the second one: **any command that fails while holding a secret may print it.** You cannot audit for this by reading your own command, because the leak is in the error path you didn't write. So the rule is about where the value lives, not about being careful with `echo`.

**The pattern:**

- **Keep the secret inside one command, read from the file, never re-exported.** This is the form `.env.example` and `docs/operator-tooling.md` already prescribe, and it is leak-resistant because the value never becomes a shell word:
  ```bash
  DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local scripts/<x>.ts
  ```
  Never `export $(grep …)`, never `VAR=$(grep …)`, never build a URL out of parts in the shell.
- **Presence checks use `-n`, never expansion.** `[ -n "$VAR" ] && echo set`. Never `${VAR:-…}`, `${VAR:+…$VAR}`, or `echo "$VAR" | cut -c1-4` (a prefix is still key material).
- **Verify by shape, not content.** Byte count is almost always enough:
  ```bash
  gcloud secrets versions access latest --secret=<name> --project <p> | wc -c
  ```
- **Pass secrets on stdin, never argv.** `--data-file=-` fed by `pbpaste | tr -d '\n'` or `read -rs`. An argv flag is visible in `ps` and lands in shell history. (`tr -d '\n'` matters: a trailing newline becomes part of the secret and produces a value that looks right everywhere and authenticates nowhere.)
- **Never `docker exec … env`, `printenv`, or dump a container's environment.**
- **`set -x` is banned in any script that touches a secret** — including startup scripts, whose output goes to the GCE serial console and is readable by anyone with `compute.instances.getSerialPortOutput`.
- **Don't paste a secret into a file the agent will later read back**, including scratchpad files. Prefer tmpfs (`/run`) and delete after use, as `deploy/worker-vm-startup.sh` does.

**If one leaks anyway: rotate it. Deleting the conversation, the log, or the terminal scrollback does not unexpose a value** — it only removes one copy of it. Rotation is the only action that restores the property you had before. In this repo that means, per credential:

| Leaked | Rotate |
| --- | --- |
| Supabase DB password | Supabase → Settings → Database → reset; then **both** `supabase-database-url` and `supabase-session-url` (same password, different ports/hosts), `.env.local`, redeploy the app service, then restart the worker VM — in that order, or the worker boots onto a dead credential |
| `YOUTUBE_API_KEY` | new key in the console → `youtube-api-key` secret → `.env.local` → redeploy → delete the old key |
| Supabase anon key | it is public by design (inlined into the client bundle) — rotating it means a **rebuild**, not a restart (`app-deploy.md` §3) |
