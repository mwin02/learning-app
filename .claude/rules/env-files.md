---
paths:
  - ".env*"
  - "**/.env*"
  - "deploy/**"
  - "scripts/operator-curl.sh"
---

# `.env.local`: change it without ever rendering it

On **2026-08-09** a verifier subagent was asked to flip `DEV_AUTH` in `.env.local`. To do that it read the file — which put every key in that file into a transcript. `YOUTUBE_API_KEY`, the Supabase database password, the operator admin token, and the `learning-app-vertex` service-account key all had to be rotated, in production and locally, because of a one-character edit.

Nothing in that sequence looked dangerous. Reading a file before editing it is the *correct* default — the Edit tool requires it. That is exactly why this needs a rule: **the safe-looking habit is the hazard.** `.env.local` is the one file in this repo where "read it, then change it" is wrong.

This is the local-file companion to AGENTS.md's "never let a secret transit your shell as a value." That rule is about the *shell*; this one is about the *transcript*. Both failure modes end the same way — the only remedy is rotation.

## The rule

**Never `Read`, `cat`, `head`, `tail`, `less`, or `grep`-without-a-filter any `.env*` file, and never open one in an editor tool.** Not to check a value, not to confirm a variable exists, not "just to see the format" — `.env.example` is the format. This binds subagents too: a subagent's transcript is as exposed as yours, and a subagent cannot see this rule unless the task that spawned it says so.

Anything you legitimately need from a `.env*` file, you can get without rendering it:

| You need | Do this |
| --- | --- |
| Which variables are set | `grep -o '^[A-Z_]*=' .env.local \| tr -d '='` |
| Whether one is set | `grep -q '^VAR=' .env.local && echo set` — never `${VAR:-…}` or `${VAR:+…}` (both expand to the value) |
| That a value looks right | byte count only: `grep '^VAR=' .env.local \| cut -d= -f2- \| tr -d "'\"" \| wc -c` |
| To use a value | `npx tsx --env-file=.env.local scripts/<x>.ts` — the process reads the file; you never do |
| To compare local against production | compare byte counts, never values: `gcloud secrets versions access latest --secret=<n> --project learning-app-prod-mzw \| wc -c` |
| To pass a secret to a command | on **stdin**: `gcloud secrets versions access latest --secret=<n> … \| node script.js`. Never argv, never a shell variable, never `VAR=$(grep …)` |

## Editing one

Edit **in place, by line prefix, with a script** — never by reading the file into context and writing it back:

```bash
python3 - <<'PY'
p = '.env.local'
lines = open(p).read().split('\n')
out = [('DEV_AUTH=1' if l.startswith('DEV_AUTH=') else l) for l in lines]
open(p, 'w').write('\n'.join(out))
PY
```

`sed -i '' 's/^DEV_AUTH=.*/DEV_AUTH=1/' .env.local` is fine for the same reason. What is *not* fine is the Edit tool (it requires a prior Read) or any rewrite that reconstructs the file from remembered content — you will silently drop the lines you never saw.

Two follow-ons:

- **No backups.** `cp .env.local .env.local.bak` creates a second secret-bearing file that a later `grep -r` or a fresh agent will happily print. If you must snapshot before a risky edit, delete the copy in the same turn you finish.
- **Never write a secret into the scratchpad**, a plan doc, a test fixture, or a log line. A scratchpad file is a file an agent reads back.

## Handling `GOOGLE_APPLICATION_CREDENTIALS_JSON` specially

`src/lib/ai/vertex.ts` prefers this variable over Application Default Credentials whenever it is **set** — so a stale or revoked key here doesn't fall back to ADC, it hard-fails every Vertex call with `invalid_grant: Invalid JWT Signature`. This is the trap the 2026-08-09 cleanup actually hit: the key was deleted in GCP but the line stayed in `.env.local`, and local Gemini was broken until it was commented out.

Local auth is **ADC** (`gcloud auth application-default login`). The variable is intentionally commented out in `.env.local` and must stay that way. Cloud Run and the worker VM both use their runtime service accounts for the same reason — `deploy/worker-vm-startup.sh` has an explicit "do not add a key here" comment.

## If a value reaches a transcript anyway

Rotate it. Deleting the conversation, the log, or the scrollback removes one copy; it does not unexpose the value. AGENTS.md ("Secrets") holds the per-credential rotation order — the Supabase one has an ordering constraint (both URL secrets → `.env.local` → redeploy the app → restart the worker), and getting it out of order boots the worker onto a dead credential.

After any rotation, verify all four surfaces before calling it done: local DB, production DB (pooler **and** direct), YouTube, and Vertex — plus `GET /api/health?probe=db` and `?probe=ai` against the deployed service. A rotation that only half-landed looks identical to one that worked until the next cold start.
