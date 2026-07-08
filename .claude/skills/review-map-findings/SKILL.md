---
name: review-map-findings
description: Work the pre-freeze map-review worklist — list open PathReview findings for a frozen Path, inspect the implicated concepts, and execute merge / dismiss / keep decisions via the map-review API, plus a delete-not-repoint escape hatch for redundant nodes a repoint-merge would cycle. Takes an optional topic or pathId. Returns a decision table.
argument-hint: [topic|pathId]
disable-model-invocation: true
allowed-tools: Bash(curl *), Bash(npx tsx *)
---

# Work the pre-freeze map-review worklist

When a Path crosses the `building → spine_ready` freeze, a whole-map critic records
quality findings as `PathReview` rows — the review the spine reviewer structurally
can't do (it runs pre-frontier, pre-split, pre-resource). Findings NEVER block the
freeze; they sit in an operator worklist to be hardened in place. This skill works
that worklist **as the operator**: list the open findings for a Path, inspect the
concepts each implicates, decide, and **execute** via the map-review API — with a
DB-level escape hatch for the one case the API can't express (see *Delete, don't
merge* below).

⚠️ **The Path is a permanent, build-once artifact.** Every decision here mutates it
forever with no rebuild. When unsure, `keep` and flag for a human — never guess a
merge. (Requires the map-review API — the Pre-Freeze Map Review Block 3 route.)

Path to work this run: **$ARGUMENTS** (a topic slug or a pathId; empty = list open
findings across all Paths, then pick one).

## Preconditions (check first, stop if unmet)

- Dev server on `http://localhost:3000` with `DEV_AUTH=1`. Probe:
  `curl -s -o /dev/null -w "%{http_code}" "localhost:3000/api/playground/map-review?topic=sql"`
  → `200`. A `404` means `DEV_AUTH` is off (the admin route 404s when unauthed) — ask
  the user to start it with `DEV_AUTH=1`. If it `500`s, the running server predates a
  schema/client change — ask the user to restart it.
- The `.env.local` DB env for the helper script (it connects directly, no server).

## Finding kinds & decision mapping

Let `B=localhost:3000/api/playground/map-review` and
`H="npx tsx --env-file=.env.local .claude/skills/review-map-findings/scripts/map-review.ts"`.

- **`duplication`** (two concepts cover the same idea) — the only *mergeable* kind.
  1. **Pick the winner** (the survivor). Prefer **spine over frontier**; among the same
     membership prefer the **broader / earlier** concept (fewer prereqs, more
     dependents). The finding's `message` carries the critic's recommendation — start
     there.
  2. **Dry-run before mutating:** `$H plan <path> <winner> <loser>`.
     - `wouldCycle: false` → **merge** it (below).
     - `wouldCycle: true` → a repoint-merge can't collapse these (they sit at different
       DAG depths — often a late **frontier** node vs an early **spine** one, whose
       inbound edges close a loop when repointed). Then, in order:
       - Try the **other winner** (`$H plan <path> <loser> <winner>`) — one direction
         is sometimes acyclic.
       - If both cycle **and the loser is REDUNDANT** (`plan` shows
         `resourceLinksMove: 0` → all its resources are already on the survivor):
         **delete it** instead of merging — see *Delete, don't merge*.
       - If both cycle and the loser carries **unique** resources/edges worth keeping →
         don't force it: `keep` and hand to manual curation.
- **`hollow`** (a concept covered only by a relaxed / low-coverage primary) — NOT
  mergeable. The fix is re-sourcing a stronger resource (remediation / sourcing, outside
  this API). `keep` it as a real gap to address, or `dismiss` if on inspection the
  coverage is actually adequate.
- **`granularity`** (an over-coarse node bundling several ideas) — NOT mergeable here.
  `keep` (hand to a split / re-author flow) or `dismiss` if it's genuinely one idea.
- **Genuinely unsure** → `keep` and flag; do not guess.

## Steps

1. **List the open worklist.**
   `curl -s "$B?topic=$ARGUMENTS"` (or `?pathId=…`, or no query for all Paths). Each
   finding: `{ id, pathId, kind, conceptSlugs, message }`.

2. **Inspect the concepts** a finding names before deciding:
   `$H inspect <path> <slugA> <slugB>` — prints each concept's membership, prereq edges
   (in/out, by slug), and resource links (role + coverage). This is how you pick the
   winner and spot a redundant node. `$H inspect <path>` with no slugs lists every
   concept + whether it has a qualifying primary.

3. **Decide** per the mapping above; **dry-run** every merge with `$H plan …` first.

4. **Execute.**
   ```sh
   B=localhost:3000/api/playground/map-review
   # merge a duplication into the named winner (the finding's other concept is the loser)
   curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"reviewId":"<id>","action":"merge","winnerSlug":"<slug>"}'
   # dismiss (not a real problem) / keep (real, handle later) — any kind
   curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"reviewId":"<id>","action":"dismiss"}'
   curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"reviewId":"<id>","action":"keep"}'
   ```
   Response codes: `200` applied; `409` the finding was already resolved / decided
   concurrently; `422` not mergeable (a non-duplication, an unknown `winnerSlug`, a
   vanished concept, or the merge **would create a prerequisite cycle** — the guard
   refused and nothing changed).

## Delete, don't merge (the escape hatch)

A `duplication` between a redundant **frontier** node and an early **spine** node often
can't be repoint-merged: the frontier node sits late in the DAG, so repointing its
inbound edges onto the early spine node closes a cycle and the API returns `422`. If
`plan` shows the loser is **redundant** (`resourceLinksMove: 0` — its resource is
already on the survivor) and its only edges are inbound, the right fix is to **delete
the node outright** rather than repoint it:

```sh
npx tsx --env-file=.env.local .claude/skills/review-map-findings/scripts/map-review.ts \
  delete-node <path> <redundant-slug> <reviewId>
```

This resolves the finding as `merged`, deletes the concept (cascading its edges +
duplicate links), and recomputes readiness — in one transaction. It refuses if the
finding is already resolved.

> **Worked example (the SQL `views` triplication).** The map had three view concepts:
> `sql-views` + `sql-view-use-cases` (both spine) and `database-views` (frontier), all
> teaching the same material. `plan` showed `sql-view-use-cases → sql-views` was
> cycle-free → merged via the API. But `database-views → sql-views` **cycled** (the
> frontier node's prereqs `joining-tables`/`selecting-data` are downstream of
> `sql-views`), and `plan` showed it was redundant (`resourceLinksMove: 0`) — so it was
> **deleted** with `delete-node`, not merged. Result: three concepts collapsed to a
> single `sql-views`, both findings resolved, Path still `spine_ready`.

## Report

Output **only** the final table — don't narrate per finding as you go. One row per
finding processed:

| Finding (kind) | Concepts | Decision | Reasoning |
|---|---|---|---|

`Decision` is one of: Merge (→winner) · Delete node · Dismiss · Keep · Skip (unsure).
Keep `Reasoning` to one line. After the table, add a one-line tally and call out any
borderline calls worth a human's second look.
