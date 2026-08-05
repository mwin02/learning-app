# Operating the review skills against production

**Status:** free-beta E2 (2026-08-04). This replaces E1's stopgap, in which the
*app* ran on a laptop and only the *database* was production. The four HTTP
curation skills now drive the **deployed** service with a real admin credential.

The five curation skills — `decompose`, `review-pending-resources`,
`review-map-findings`, `author-concept-bank`, `review-topic-filing` — are the
operator surface for the beta. Four of them call admin API routes;
`review-topic-filing` deliberately does not, and is covered in its own section
below.

## Setup (once)

### 1. Confirm the admin on production

There is deliberately no API for role assignment (`src/lib/api/with-admin-auth.ts`),
so roles are set by hand. Read the current state first — as of 2026-08-04
production has exactly one `User` row and it is **already** `role='admin'`, so
this step is usually just fetching the id:

```bash
DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local -e "import {prisma} from '@/lib/db'; prisma.user.findMany({select:{id:true,email:true,role:true}}).then(u=>console.log(u))"
```

Keep the `User.id` of the admin row — it is `OPERATOR_ADMIN_USER_ID` below. If
the row you want is not yet an admin, promote it (Supabase Studio's SQL editor
works equally well; the point is that it is a manual act):

```bash
DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local -e "import {prisma} from '@/lib/db'; prisma.user.update({where:{email:'you@example.com'},data:{role:'admin'}}).then(u=>console.log(u.id,u.role))"
```

### 2. Generate the operator token

```bash
openssl rand -base64 32
```

Put it in `.env.local` alongside the other two vars, and **nowhere else that a
shell will read it back**:

```
OPERATOR_BASE_URL=https://learning-app-sau6bxtxta-uw.a.run.app
OPERATOR_ADMIN_TOKEN=<the value>
OPERATOR_ADMIN_USER_ID=<the User.id from step 1>
```

### 3. Provision the same values in cloud

The service checks the token against its own env, so the two must match. Create
the secrets (stdin, never argv — see AGENTS.md), then redeploy:

```bash
pbpaste | tr -d '\n' | gcloud secrets create operator-admin-token --data-file=- --project <project>
```

```bash
printf '%s' '<the User.id>' | gcloud secrets create operator-admin-user-id --data-file=- --project <project>
```

Then grant the Cloud Run runtime service account read access — bindings go **on
each secret**, never the project (`app-deploy.md` §5), and without them the
deploy fails:

```bash
for s in operator-admin-token operator-admin-user-id; do gcloud secrets add-iam-policy-binding $s --member serviceAccount:$SA --role roles/secretmanager.secretAccessor --project $PROJECT_ID --condition=None; done
```

`cloudbuild.yaml` already mounts both onto the Cloud Run service, so a merge to
`main` picks them up. `OPERATOR_BASE_URL` is local-only and is not deployed —
the service has no reason to know its own operator URL.

> ⚠️ **Create the secrets and their bindings BEFORE merging E2.** `cloudbuild.yaml`'s
> `--set-secrets` now names `operator-admin-token:latest` and
> `operator-admin-user-id:latest`; a `gcloud run deploy` referencing a secret that
> does not exist (or that the runtime SA cannot read) **fails the deploy step**, so
> the merge would leave production on the previous revision. Order: secrets → IAM →
> merge.

Verify by shape, never by content:

```bash
gcloud secrets versions access latest --secret=operator-admin-token --project <project> | wc -c
```

44 is right for `openssl rand -base64 32`. **45 means a trailing newline got in**,
which produces a token that looks correct everywhere and authenticates nowhere.

### 4. Confirm end to end

```bash
scripts/operator-curl.sh "/api/playground/pending-resources?limit=1" -s -o /dev/null -w "%{http_code}\n"
```

`200` and you are done. `404` is the only failure you will see — admin routes
are non-enumerable by design and never return 401/403 for a bad credential — so
work through: token mismatch between `.env.local` and Secret Manager, a redeploy
that hasn't landed, `OPERATOR_ADMIN_USER_ID` naming a row whose `role` is not
`admin`, or a trailing newline in the secret.

## How it works

`scripts/operator-curl.sh <path> [curl args…]` is the only way the four HTTP
skills reach an admin route. It reads both values out of `.env.local`, prepends
the base URL, and attaches `Authorization: Bearer …`:

```bash
scripts/operator-curl.sh "/api/playground/pending-resources?limit=5" -s
```

```bash
scripts/operator-curl.sh /api/playground/resources -s -XPATCH -H 'content-type: application/json' -d '{"resourceId":"…","fields":{"durationMin":540}}'
```

Server-side, `withAdminAuth` resolves the token to `OPERATOR_ADMIN_USER_ID` and
then runs the **same `role = 'admin'` lookup it runs for a session**. The
credential identifies; the database authorizes. Two consequences worth knowing:

- **Revocation is immediate and needs no redeploy.** `UPDATE "User" SET role='user'`
  on that row kills the token on the next request.
- **The token is inert unless both env vars are set**, and a value under 32 bytes
  is rejected outright — a placeholder or an empty secret version fails closed
  rather than becoming a guessable admin credential.

The Node decompose routes (`node-toc`, `anchor-toc`, `video-chapters`) can't use
a shell wrapper, so they `require`
`.claude/skills/decompose/scripts/operator-post.cjs`, which applies the same
rules from Node.

### Why a token and not a real session

Supabase's SSR session cookies are httpOnly, so "authenticate as a signed-in
admin" means driving every call through a browser tab — and the operator surface
is ~20 `curl` calls across eight skill files, several inside bash loops. The
token keeps the call sites in the shape the skills are written in. It is not a
weaker credential than a session here: it is scoped to one named admin row,
revocable from the database, and it never rides a cookie, so it cannot be
replayed by CSRF.

The exceptions, both browser-shaped, still need a real signed-in admin session:

- **Playground *pages*** (`/playground/…`) are gated by `requireAdminPage`, which
  reads a session. The token authenticates the **API only**. This matters in
  `author-concept-bank`, which reads `generated://` lessons off a page.
- **The `browser-spa` decompose route** harvests and POSTs from the tab itself,
  so it authenticates with the admin's own cookies. See
  `.claude/skills/decompose/references/browser-spa.md`.

## Confirm the target before every review pass

A review pass mutates curation data irreversibly, and — unlike E1 — there are now
**two** independent targets that can disagree: the API base URL and, for the
direct-DB helpers, `DATABASE_URL`.

`operator-curl.sh` prints its target on **every** call, so the answer is in the
transcript rather than in whatever you remember about how a server was started:

```
[operator-curl] POST https://learning-app-sau6bxtxta-uw.a.run.app/api/playground/pending-resources  ⚠ REMOTE
```

The direct-DB helpers print theirs in the shared `describeDatabaseUrl` format
(`src/lib/db-target.ts`):

| Surface | Where it prints |
| --- | --- |
| The four HTTP skills | `[operator-curl] <METHOD> <base><path>`, stderr, every call |
| `topic-review.ts`, `pending-review-db.cjs`, `decomp-db.cjs`, `map-review.ts` | `[db] host:port/dbname`, stderr, every run |
| `reset-maps` / `reset-content` / `topic-review apply` | `[<script>] target: …`, plus `⚠ REMOTE` off localhost |
| Node decompose routes | `[operator-post] POST <url>`, stderr, every call |

`…pooler.supabase.com:6543/postgres` is the database behind the production
service; `localhost:55432/learning_app` is the disposable local one. **Check that
the API base and the helper's database agree** — a helper sampling local rows
while the API approves production ones is the failure this exists to catch.

## Hazards

**A wrong-target read fails silently.** Pointed at the empty local library, a
review skill reports an empty queue — which reads as "nothing to review", not as
"wrong target". There is no error to notice.

**`OPERATOR_BASE_URL` has no default, and must not acquire one.** A skill that
silently falls back to `localhost:3000` when the intended target is production is
worse than E1's invisible target, because the reviewer has no reason to suspect
anything. `operator-curl.sh` and `operator-post.cjs` both refuse to run
unconfigured; keep it that way.

**Never let the token transit the shell.** Both of this repo's real leaks came
from a command that printed a secret as a *side effect of failing* (AGENTS.md).
`operator-curl.sh` reads it from `.env.local` straight into a curl config on a
pipe — never a variable, never argv, never exported. Don't work around this by
exporting it "just for one command", and don't paste it into a scratchpad file.
If it leaks, rotate: new `openssl rand`, new secret version, `.env.local`,
redeploy.

**Never point `.env.local`'s `DATABASE_URL` at production.** Unchanged from E1
and still the sharpest edge: that setting outlives the command, and the next
`npm run test:int` or `docker compose --profile workers up` inherits it — test
fixtures written into the live library, production queue drained by a laptop's
worker. Override inline, for one command:
`DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local …`.

**Use the pooler URL (`:6543`), not `SUPABASE_DB_URL`.** The latter is the direct
5432 endpoint and is **IPv6-only** on current Supabase projects. It happens to
work from a laptop, which is what makes it a trap to standardise on: anything
IPv4-only fails with an opaque Prisma `P1001` (Cloud Build hit exactly this).
`SUPABASE_DB_URL` is scoped to the one-shot D2 library migration.

**`DEV_AUTH` is no longer part of the operator path.** It still exists for local
development against a throwaway database, and it is still inert in any deployed
build (`devBypass()` requires `NODE_ENV=development`; the standalone server
hardcodes `production`). Do not reach for it expecting it to reach production
data — it cannot, and if a skill's probe fails, the cause is the token, not
`DEV_AUTH`.

## `review-topic-filing` is deliberately the exception

It drives `.claude/skills/review-topic-filing/scripts/topic-review.ts` against
Postgres directly and has no HTTP path at all. E2 settled this on purpose: it is
a bulk reclassification with no admin route behind it, so building one would add
endpoints with no other consumer. Its interface stays the `DATABASE_URL`
override, and its gate stays `scripts/target-guard.ts`:

```bash
DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local .claude/skills/review-topic-filing/scripts/topic-review.ts queue
```

## What this does not cover

- **Destructive whole-database scripts** (`reset-maps`, `reset-content`, and
  `topic-review apply --apply`) have their own guard: off localhost they refuse
  to run without `--target-host=<hostname>` naming the target explicitly
  (`scripts/target-guard.ts`). Documented here only so the extra flag is not a
  surprise.
- **Admin-only probes on the deployed service** (`/api/health?probe=throw`,
  `probe=ai`) — those are `withAdminAuth` routes, so the operator token now
  reaches them: `scripts/operator-curl.sh "/api/health?probe=ai" -s`. See
  `app-deploy.md` §8.
- **Migrations** against production are Cloud Build's job (`app-deploy.md` §3a),
  not an operator's.
- **Attribution of individual curation writes.** `withAdminAuth` now hands every
  handler a real `adminId` instead of `null`, and logs `admin.operator_token_auth`
  per authenticated call — but no handler persists it onto the rows it writes.
  The `origin: 'review'` audit trail still records *that* a review happened, not
  *who* did it. Wiring `adminId` through the write paths is a separate change.
