<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hosting portability

We deploy to Vercel now but plan to migrate to Cloud Run after Phase 3 ships (first paying customer). To keep that migration a half-day move rather than a week:

- **Avoid Vercel-only features**: edge middleware, Vercel KV / Postgres / Blob, Vercel Cron, the Vercel `next/image` loader. Anything that only exists because Vercel hosts the app is a future migration tax.
- `next.config.ts` sets `output: 'standalone'` — produces `.next/standalone/` for a trivial Cloud Run Dockerfile. Vercel ignores the flag.
- If a feature genuinely needs a Vercel-only primitive, raise it in discussion before reaching for it.

# Migrations: never drop the pgvector index

`Resource.embedding` is an `Unsupported("vector(768)")` column and its hnsw index (`Resource_embedding_idx`) is created in raw SQL (the AR-1 migration), because Prisma can model neither. So **every** `prisma migrate dev` reads that index as drift and prepends `DROP INDEX "Resource_embedding_idx";` to the new migration. Dropping it is wrong — it's the semantic-search index that `searchResources` depends on.

**Every time you generate a migration:**
1. Open the generated `migration.sql` and **delete any `DROP INDEX "Resource_embedding_idx"` line** (and its `-- DropIndex` comment). Leave a short note in the file explaining why, as `20260602145709_topic_alias_registry` and `20260611121438_phase_2_5e_track_target_mastery` do.
2. If you already ran `migrate dev` before noticing (it applies the drop immediately), the index is now gone from your local DB — recreate it:
   `CREATE INDEX IF NOT EXISTS "Resource_embedding_idx" ON "Resource" USING hnsw ("embedding" vector_cosine_ops);`
   and reconcile the recorded checksum (`migrate dev` stored the hash of the un-edited file): update `_prisma_migrations.checksum` for that migration to the sha256 of the corrected file, or `migrate status` / a later `migrate dev` will flag it as modified-after-apply.
3. Confirm `SELECT indexname FROM pg_indexes WHERE indexname = 'Resource_embedding_idx';` returns the row before moving on.

Editing the `migration.sql` *before* the first apply avoids steps 2–3 entirely — check the diff the moment it's generated.
