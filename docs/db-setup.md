# Local database setup

Prisma migrations are authored against a **local Docker Postgres**, never the
production Supabase database. Production is reached only by
`prisma migrate deploy` running from Vercel during build.

This split exists because `prisma migrate dev` will offer to `migrate reset`
(drop + recreate the database) whenever it detects schema drift. Pointed at
prod, that would wipe the Resource library and any user data. Pointed at local,
it's free.

## One-time setup

1. Install Docker Desktop (or any Docker engine).
2. From the repo root:
   ```bash
   docker compose up -d
   ```
   Starts Postgres 17 (the `pgvector/pgvector:pg17` image, which bundles the
   `vector` extension that Phase 2.5-AR's migration enables) on
   `localhost:55432` with an empty `learning_app` database. Data persists in
   the `learning_app_pgdata` named volume across restarts.

   > If you have an existing volume created under the old stock `postgres:17`
   > image, swapping to the pgvector image can raise a glibc collation-version
   > warning. Clear it once with
   > `ALTER DATABASE <db> REFRESH COLLATION VERSION;` on `learning_app`,
   > `template1`, and `postgres`, or just reset the volume
   > (`docker compose down -v && docker compose up -d`).
3. In `.env.local`, set:
   ```
   DIRECT_URL=postgresql://postgres:postgres@localhost:55432/learning_app
   ```
   Leave `DATABASE_URL` pointing at the Supabase pooler — the app still reads
   from production in local dev.
4. Apply migrations and seed:
   ```bash
   npx prisma migrate deploy
   npm run db:seed
   ```

## Day-to-day

- **Authoring a migration:** edit `prisma/schema.prisma`, then
  `npx prisma migrate dev --name <slug>`. Writes a new migration file and
  applies it to the local DB. Commit the migration file with the schema change.
- **Pulling a fresh schema from prod** (rare — for verification only):
  `npx prisma db pull --print > /tmp/prod-schema.prisma` after temporarily
  pointing `DIRECT_URL` at Supabase. Don't commit the result.
- **Resetting local:** `docker compose down -v && docker compose up -d`,
  then re-run `migrate deploy` + seed.

## Caveat: schema skew during dev

While `DIRECT_URL` points at local and `DATABASE_URL` points at prod, the app
will run against the prod schema even though your local DB may be ahead. Any
query that references a not-yet-deployed column or table will fail at runtime
in local dev. Deploy the migration to prod (via PR → Vercel) before exercising
that code path locally, or temporarily point `DATABASE_URL` at the local DB for
end-to-end testing.

## Caveat: `prisma db pull` doesn't catch everything

Schema comparison via `db pull` covers tables, columns, indexes, and enums —
everything modeled in `schema.prisma`. It does **not** see Supabase-managed
state such as RLS policies, custom extensions, or auth schemas. The project
doesn't rely on those today; when it does, this doc should be revisited.

## Production path

- `DATABASE_URL` (Vercel) → Supabase transaction pooler, port 6543.
- `DIRECT_URL` (Vercel) → Supabase direct connection, port 5432.
- Build step runs `prisma migrate deploy` against `DIRECT_URL`. Never
  `migrate dev` — that command is forbidden against prod.
