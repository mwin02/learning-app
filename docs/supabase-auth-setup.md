# Supabase Auth setup + verification (Phase 3b)

One-time dashboard/GCP setup that only a human with project access can do, followed
by the manual verification pass for the 3b auth block ([PR link in the 3b PR]).
Code side is already wired: `@supabase/ssr` clients, `src/proxy.ts` session
refresh, `/auth/login|callback|signout`, and the real `withAuth`/`withAdminAuth`.

## 1. Google OAuth credentials (GCP)

1. GCP Console → the project already used for Vertex → **APIs & Services →
   OAuth consent screen**. Configure if not yet done: External, app name, your
   email; scopes `email` + `profile` + `openid` (the defaults). Publish (or add
   yourself as a test user while in Testing).
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `https://<PROJECT-REF>.supabase.co/auth/v1/callback`
     — the **Supabase** callback, not ours. Find the exact value in the Supabase
     dashboard on the Google-provider page (step 2 below); copy it from there.
3. Keep the **Client ID** and **Client secret**.

## 2. Supabase dashboard

1. **Authentication → Providers (Sign In / Up) → Google**: enable, paste the GCP
   Client ID + secret. This page also shows the `…/auth/v1/callback` URL for
   step 1.2.
2. **Authentication → URL Configuration**:
   - Site URL: the production URL (e.g. `https://<app>.vercel.app`) — or
     `http://localhost:3000` until there's a prod domain.
   - **Redirect URLs**: add both
     - `http://localhost:3000/auth/callback`
     - `https://<prod-domain>/auth/callback`
   Our `/auth/login` passes `redirectTo` = origin + `/auth/callback`; Supabase
   only honors it if it's in this allowlist (otherwise it falls back to the Site
   URL and sign-in appears to "work" but lands on the wrong host).

## 3. Env vars

In `.env.local` (and later the Vercel dashboard), from **Project Settings → API**:

```
NEXT_PUBLIC_SUPABASE_URL=https://<PROJECT-REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon / publishable key>
```

Restart `next dev` after setting them (env is read at boot). No service-role key
— nothing needs it (see `.env.example`).

## 4. Deploy the 3a migration to the Supabase DB (before full verification)

The callback's user-sync upserts into `User`, but the shared Supabase DB only
has the 3a columns (`email`, `role`, …) after the migration runs there. Locally
it was applied to Docker only. Either let the next Vercel build run
`prisma migrate deploy`, or run it by hand against Supabase:

```bash
# temporarily point DIRECT_URL at the Supabase DIRECT connection (port 5432),
# then restore it to the local Docker value afterwards
set -a; . ./.env.local; set +a
DIRECT_URL="postgresql://postgres:<PASSWORD>@db.<PROJECT-REF>.supabase.co:5432/postgres" \
  npx prisma migrate deploy
```

Until this is done, sign-in still works but the callback logs
`[auth/callback] user sync failed` and no `User` row appears — that's the
designed graceful path, not a 3b bug.

## 5. Verification pass (3b)

With the dev server running (`npm run dev`):

1. **Sign-in flow:** visit `http://localhost:3000/auth/login` → Google consent →
   should land back on `http://localhost:3000/` with session cookies set
   (DevTools → Application → Cookies: `sb-…-auth-token`).
2. **User row mirrored** (requires step 4): check `User` in Supabase Studio
   (Table Editor) — one row: your UUID, gmail, display name, `role = user`.
3. **withAuth, real session:** while signed in (browser), hit a wrapped route —
   e.g. from the landing page console:
   `fetch('/api/generate-path', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'}).then(r=>r.status)`
   → expect **400** (Zod validation — proves the handler ran with your session).
4. **withAuth, no session:** `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/api/generate-path -H 'content-type: application/json' -d '{}'`
   with `DEV_AUTH` **unset** in `.env.local` (restart dev server) → expect
   **401**. (With `DEV_AUTH=1` it's 400 — the dev bypass.)
5. **Admin role:** in Supabase Studio run
   `UPDATE "User" SET role = 'admin' WHERE email = '<your gmail>';`
   Then, still with `DEV_AUTH` unset, load a playground API in the signed-in
   browser, e.g. `fetch('/api/playground/resource-search?q=python').then(r=>r.status)`
   → non-404 for you; the same via curl (no cookies) → **404**.
6. **Sign-out:** `document.querySelector` isn't needed — from the browser
   console: `fetch('/auth/signout', {method:'POST'})` then reload → cookies
   gone; step 3's fetch now returns 401.
7. Restore `.env.local` (`DEV_AUTH=1`) for normal local work.

## 6. Verification pass (3c — limits, enrollment, program naming)

Needs §1–5 done (real session + 3a migration on the shared dev DB). Signed in,
dev server running:

1. **Integration tests** (worker stopped, `DATABASE_URL` set):
   `npm run test:int` — the new `program-enrollment` suite must pass (it fails
   with a missing-column/table error if §4 hasn't run).
2. **One real program** (costs one plan-pass LLM call + child builds — do this
   once, with the course worker running): from the signed-in browser console:
   ```js
   fetch('/api/generate-program', { method: 'POST', headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ goal: 'refresh calculus before fall semester', totalHoursPerWeek: 4, totalWeeks: 6 }),
   }).then(r => r.json()).then(console.log)
   ```
   → `202 { programId, status: 'building', topicCount }`. Check in Studio:
   - the `Program` row has a **neutral `title` + `description`** (no personal
     details even if you put them in the goal),
   - `EnrolledProgram` has a row for (you, programId) — creator auto-enroll,
   - single-topic behavior: a goal like the above should yield **1** ProgramPath
     (the plan pass shouldn't pad it with adjacent topics).
3. **Quota (without burning 3 real builds):** insert dummy rows for your user in
   Studio until the month's count is 3 —
   ```sql
   INSERT INTO "Program" (id, goal, "totalHoursPerWeek", "totalWeeks", status, "userId", "createdAt", "updatedAt")
   VALUES ('quota-test-1', 'quota filler', 1, 1, 'ready', '<your-user-uuid>', now(), now());
   ```
   (repeat with distinct ids) — then re-run the fetch from step 2 → expect
   **429 `FREE_LIMIT_REACHED`** with `{ used, limit }`. Delete the filler rows
   after (`DELETE FROM "Program" WHERE goal = 'quota filler';`).
4. **Enroll endpoint:** with a second Program id (or after un-enrolling yourself
   in Studio):
   `fetch('/api/programs/<id>/enroll', { method: 'POST' }).then(r => r.status)`
   → 200 and an `EnrolledProgram` row; repeat → still 200 (idempotent);
   a made-up id → 404.
5. **generate-path is admin-only now:** signed in as a NON-admin (or via curl
   with no cookies, `DEV_AUTH` unset) → `POST /api/generate-path` → **404**;
   as admin (§5.5) → 400 `INVALID_INPUT` on an empty body (handler ran).

## 7. Verification pass (3d — page gating + program privacy)

Needs §1–5. Two browsers help here: one signed in as you (call it A), one
incognito/anonymous (call it B). Use a Program you created in §6 (its id from
Studio) and one of its Track ids (ProgramPath.trackId once built).

1. **Anonymous redirect:** in B, open `/programs/<id>` → redirected to Google
   sign-in (via `/auth/login?next=…`); same for `/learn/<trackId>`. After
   completing sign-in in B (a second Google account if you have one), you land
   back on the page you asked for.
2. **Unenrolled view + privacy:** in B (signed in, NOT the creator), open
   `/programs/<id>` → the barebones enroll card shows the **generated
   title/description — not your goal/background text** (put something
   identifiable in the goal in §6 to make this checkable). The tab title is the
   generated title too.
3. **Enroll flow:** click "Enroll — free" in B → page refreshes into the program
   hub. The hub heading for B is still the sanitized title (goal/background
   stay creator-only); in A (creator) the hub shows the raw goal + background.
4. **Track gating:** in B, open `/learn/<trackId>` of a Track in that program →
   renders. Un-enroll B in Studio (delete its EnrolledProgram row) → same URL
   now 404s. A non-`ready` Track id (Studio: any Track with status ≠ ready)
   404s for non-admins even when enrolled.
5. **Playground pages:** in B (non-admin) `/playground/...` → 404. In A after
   the §5.5 admin grant → renders. With `DEV_AUTH` unset and no session (curl)
   → 404.

## 8. Verification pass (3e — barebones account UI)

Needs §1–5. This is the end-to-end product loop, so it subsumes parts of §6–7:

1. **Landing (`/`)**: anonymous → hero + "Continue with Google"; after sign-in →
   your name/email, Create-a-program + My-programs links, admin Playground link
   only if your role is admin, working Sign out (returns to the anonymous view).
2. **Create flow**: `/programs/new` → fill goal/hours/weeks → submit → lands on
   `/programs/<id>` showing the planning/building hub, which **auto-refreshes
   every ~5s** until the worker (running!) finishes and it flips to the built
   program — no manual reloads.
3. **My programs (`/programs`)**: lists your enrollments newest-first with
   status; while something is building the list self-refreshes. As a creator you
   see your goal as the subtitle under the generated title; in the second
   (non-creator) browser, an enrolled program shows only the title.
4. **Quota surface**: with the month's quota filled (§6.3 filler rows), submit
   the form again → inline "free limit" message, no crash. Also try a nonsense
   goal ("asdfgh") → the PLAN_EMPTY message.

## Troubleshooting

- **`redirect_uri_mismatch` (Google page):** the GCP OAuth client's redirect URI
  isn't exactly the Supabase `…/auth/v1/callback` value.
- **Lands on `/?auth_error=1`:** code exchange failed — check the dev-server log
  line `[auth/callback] code exchange failed`; usually a stale/mistyped anon key
  or the redirect URL missing from the Supabase allowlist.
- **Signed in but no `User` row:** step 4 not done yet (look for
  `[auth/callback] user sync failed` in the server log).
- **`/auth/login` returns 503 `AUTH_NOT_CONFIGURED`:** env vars not set/loaded —
  restart the dev server.
