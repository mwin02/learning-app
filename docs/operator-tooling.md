# Operating the review skills against production

**Status:** free-beta E1 (2026-07-31). This is a **stopgap**, deliberately.
E2 replaces it with real admin auth against the deployed service; until then this
is how the curation skills reach the live library.

The five curation skills — `decompose`, `review-pending-resources`,
`review-map-findings`, `author-concept-bank`, `review-topic-filing` — are the
operator surface for the beta. Four of them drive `curl localhost:3000/api/playground/…`;
`review-topic-filing` bypasses HTTP and drives the DB directly. All five were
built when there was only one database, the local Docker Postgres. There are now
two, and the curated library lives on the other one.

## Why the app runs locally

The skills need `DEV_AUTH`, and `DEV_AUTH` cannot work in the cloud by
construction: `devBypass()` requires `NODE_ENV === 'development'`
(`src/lib/api/with-auth.ts:33`) and Next's standalone server hardcodes
`NODE_ENV=production`. There is also no admin on the deployed service — roles are
assigned by hand and there is deliberately no API for it
(`src/lib/api/with-admin-auth.ts`). So for now the *app* stays on the laptop and
only the *database* is production.

## The pattern

Start the dev server with `DATABASE_URL` overridden inline, and leave
`.env.local` alone:

```bash
DATABASE_URL="$SUPABASE_POOLER_URL" npm run dev
```

`SUPABASE_POOLER_URL` is documented in `.env.example` and is uncommented in your
local `.env.local` if you operate against production. Left unset it expands to
empty — and since a set-but-empty shell variable still beats `--env-file`, the
server aborts on `DATABASE_URL is not set` rather than quietly running against
local. That is the intended failure.

Every skill then works unchanged and writes to Supabase.

The two **direct-DB** helpers take the same override, since shell env beats
`--env-file`:

```bash
DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local \
  .claude/skills/review-topic-filing/scripts/topic-review.ts queue
DATABASE_URL="$SUPABASE_POOLER_URL" node \
  .claude/skills/review-pending-resources/scripts/pending-review-db.cjs <cmd>
```

## Confirm the target before every review pass

A review pass mutates curation data irreversibly. Confirm which database you are
pointed at **first** — the check is cheap and the mistake is not.

Everything that resolves `DATABASE_URL` prints the same `host:port/dbname` string
(`describeDatabaseUrl`, `src/lib/db-target.ts`):

| Surface | Where it prints |
| --- | --- |
| The app (all four HTTP skills) | dev-server terminal: `{"event":"db.client_created","target":"…"}` |
| `topic-review.ts`, `pending-review-db.cjs`, `decomp-db.cjs` | stderr, `[db] …`, every run |
| `reset-maps` / `reset-content` / `topic-review apply` | `[<script>] target: …`, plus `⚠ REMOTE` off localhost |

The app's line is emitted when the Prisma singleton is built, which under
`next dev` is **on the first request that touches the DB**, not at startup — so
it appears in the terminal in response to the skill's own precondition probe,
before any mutation. If you have scrolled past it, re-read it by hitting the
probe again in a fresh terminal (`curl -s localhost:3000/api/playground/pending-resources?limit=1 >/dev/null`)
and watching the server's output; the singleton is cached, so restart the server
if you need the line re-emitted.

Expected values:

- `localhost:55432/learning_app` — local Docker Postgres. Safe to break.
- `…pooler.supabase.com:6543/postgres` — **production**. Every write is real.

## Hazards

These are the whole risk of this pattern. Read them once properly.

**The target is invisible at the call site.** A skill's `curl localhost:3000/…`
is byte-identical whichever database the server was started against. There is
nothing in the command that says which library you are editing — the `db.client_created`
line above exists *because* of this, and it only helps if you actually look at
it. Get in the habit of confirming before a review pass, not after a surprising
result.

**Use the pooler URL (`:6543`), not `SUPABASE_DB_URL`.** The latter is the direct
5432 endpoint and is **IPv6-only** on current Supabase projects. It happens to
work from a laptop, which is exactly what makes it a trap to standardise on:
anything IPv4-only fails with an opaque Prisma `P1001` (Cloud Build hit exactly
this). `SUPABASE_DB_URL` is scoped to the one-shot D2 library migration and
should not appear in any other command.

**Never solve this by editing `.env.local`.** `.env.local`'s `DATABASE_URL`
points at local Docker Postgres *deliberately* — that is a safety property, not
an oversight. The setting outlives the command, and the next
`npm run test:int` or `docker compose --profile workers up` inherits it: test
fixtures written into the live library, and the production queue drained from a
laptop by a background worker. Always override inline, for one command.

**A wrong-database read fails silently.** Pointed at the empty local library, a
review skill reports an empty queue — which reads as "nothing to review", not as
"wrong database". There is no error to notice.

**Reviews mutate production curation at `DEV_AUTH`-level (i.e. no)
authentication.** Anything that reaches `localhost:3000` while the server is
pointed at production can rewrite the live library with no session at all. That
is acceptable for a single operator on a laptop, for the length of a review pass.
It is not acceptable as a standing arrangement, which is why E2 exists. Stop the
overridden server when the pass is done.

## What this does not cover

- **Destructive whole-database scripts** (`reset-maps`, `reset-content`, and
  `topic-review apply --apply`) have their own guard on top of this:
  off localhost they refuse to run without `--target-host=<hostname>` naming the
  target explicitly (`scripts/target-guard.ts`). Documented here only so the
  extra flag is not a surprise.
- **Admin-only probes on the deployed service** (`/api/health?probe=throw`,
  `probe=ai`) are a different problem — they need a real admin session against
  Cloud Run, not a local server. See `app-deploy.md` §8.
- **Migrations** against production are Cloud Build's job (`app-deploy.md` §3a),
  not an operator's.
