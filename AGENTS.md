<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hosting portability

We deploy to Vercel now but plan to migrate to Cloud Run after Phase 3 ships (first paying customer). To keep that migration a half-day move rather than a week:

- **Avoid Vercel-only features**: edge middleware, Vercel KV / Postgres / Blob, Vercel Cron, the Vercel `next/image` loader. Anything that only exists because Vercel hosts the app is a future migration tax.
- `next.config.ts` sets `output: 'standalone'` — produces `.next/standalone/` for a trivial Cloud Run Dockerfile. Vercel ignores the flag.
- If a feature genuinely needs a Vercel-only primitive, raise it in discussion before reaching for it.

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
