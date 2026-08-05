---
name: review-pending-resources
description: Browser-review resources in the pending_review approval queue against a content-quality rubric, then approve/reject them via the pending-resources API. Takes the number of queue roots to process; samples children for container resources. Returns a decision table.
argument-hint: [count]
disable-model-invocation: true
allowed-tools: Bash(scripts/operator-curl.sh *), Bash(node *), mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__select_browser, mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__browser_batch, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__read_page
---

# Review the pending_review approval queue

Resources discovered by the web fallback land as `status='pending_review'` — usable in the run that found them, but hidden from future runs by the gate until approved. This skill works that queue **as a reviewer**: pull a batch, open each resource in a real browser, grade it against the rubric below (so we catch what discovery's URL-only validators can't — login walls, parked pages, metadata mismatches), then **execute** the decision via the pending-resources API. This is the human/POC stand-in for the autonomous review agent.

Number of queue **roots** to process this run: **$ARGUMENTS** (default 10 if empty). Note `limit` counts top-level roots, not flattened resources — one root may be a large container subtree.

## Preconditions (check first, stop if unmet)

- **The API target, confirmed and stated.** Every admin call goes through `scripts/operator-curl.sh <path> [curl args]`, which supplies the base URL and the admin credential from `.env.local`. It has **no localhost default** and refuses to run unconfigured. Probe: `scripts/operator-curl.sh "/api/playground/pending-resources?limit=1" -s -o /dev/null -w "%{http_code}"` → `200`. A `404` means the operator token is missing/wrong or its `User` row is not `role='admin'` — admin routes 404 rather than 401 by design; stop and see `docs/operator-tooling.md`. If the base URL is a localhost one, the dev server has to be running.
- **Say which service you are approving into, in your first message.** The script prints `[operator-curl] GET <base><path>` to stderr on every call, with a `⚠ REMOTE` marker off localhost — read it off the probe. Remote means the production library and every approve/reject is real.
- **The `pending-review-db.cjs` helper is a separate target** — it talks to Postgres directly and follows `DATABASE_URL`, not `OPERATOR_BASE_URL`, so the two can disagree. It prints `[db] host:port/dbname` to stderr on every run; confirm it is the database behind the API base you probed (`…pooler.supabase.com:6543/postgres` is production, `localhost:55432/learning_app` is disposable). Pointed at the wrong one it returns **empty**, not an error — "nothing pending" is the symptom.
- A Chrome browser connected via the Claude-in-Chrome extension. `list_connected_browsers`; if empty, ask the user to connect it. `select_browser` the device, then `tabs_context_mcp` with `createIfEmpty: true` and use that one tab for everything.

## Rubric (grade each resource against the actual rendered page)

1. **Live & renders** — loads to real content, not a 404/410/parked/error page. (If `get_page_text` is empty, the page may be a JS-rendered SPA — confirm with `read_page` before calling it dead.)
2. **No access barrier** — main content readable/watchable without creating an account, logging in, or paying. Free-but-signup (e.g. email-gated videos) still fails this.
3. **Teaches directly** — the page itself teaches the topic; not a listicle, link aggregator, marketing/sales/signup landing page.
4. **Metadata accuracy** — page matches the stored title / type / difficulty / conceptsTaught. **Scope match for `type='book'` rows:** confirm the URL lands on the stated chapter/section, not the entire work — a whole-work landing page (front matter, full table of contents) under a chapter-scoped title misrepresents its scope → **reject soft**.
5. **Duration sanity** — while the page is open, estimate real consumption time: visible video length; article word count ÷ ~200 wpm; PDF page count × ~2 min/page. Stored `durationMin` for text resources is an unverified discovery-time LLM guess, and real gates trust it (the 300-min attach ceiling, duration ranking, the track time allocator). If the stored value is off by more than ~2× in either direction, **PATCH the correction first** (see the resources API below), *then* make the approve/reject decision. If the corrected value exceeds 300 min on an atomic row, do **not** approve — the PATCH response returns a `warning` signalling exactly this; reject (soft) if the content is weak, or send it to the decompose queue via `action: "decompose"` if it's good but container-sized. YouTube rows are exact (Data API) and never need this check.

### Decision mapping

- All pass → **approve** (atomic root) or **approve cascade** (container — promotes the whole subtree).
- Fails #1, broken/dead/removed → **reject hard**.
- Fails #2/#3/#4, page works but violates a quality rule or is misrepresented → **reject soft**.
- Fails #5 with a corrected duration **over 300 min on an atomic row** → after PATCHing the correction, **reject soft** (weak content) or **send to decompose** (`action: "decompose"` — good content that's really a container: a course TOC, a whole book). Never approve. A correction that stays ≤300 doesn't change the decision — fix it and grade normally.
- **Misclassified atomic container** (an `atomic` row whose page is actually a course TOC / whole work, regardless of duration, **whose linked units do not already exist as rows**) → `action: "decompose"` — it re-routes to the decomposition queue (`decompositionStatus: pending`), drops out of this queue's actionable list, and (like reject) removes the row's concept-map candidate links with readiness recomputed — remediation refills any reopened spine hole. Atomic rows only; the API 409s on anything else.

  The existence clause is the whole distinction from **Exposed index pages** below, and it is not cosmetic — both rules describe "an atomic row whose page is a TOC", and they prescribe opposite actions. Ask *where the pages it links to are*: **nowhere in the library** → this rule, decompose creates them. **Already sitting beside it as sibling rows** in the same container → the other rule, decompose creates nothing and reject is the repair. A root-level row pulled straight from the queue is almost always the first; an `atomic` child inside a `decomposed` container is almost always the second.
- `blocked: true` in the queue (decompositionStatus `pending`/`human_review`) → **skip**, flag "resolve in Human review first" (the API 409s on these anyway).
- **Exposed index pages** (a `decomposed` container with one or more `atomic` children whose page is a chapter-index / intro / table-of-contents that links to *sibling* rows rather than teaching) → do **not** approve-cascade: it would publish those index pages as pickable duplicates of the very units they list (a pre-multi-layer decomposition artifact). Decide per child instead — see below. Partial counts: the container does **not** have to be uniformly flat, and usually isn't. A container with one properly nested `decomposed` chapter and two chapters flattened around it has exactly this defect in two places.

  **Rejecting the index rows is the repair — re-decomposition is not.** An exposed index page is an `atomic` row that fails **rubric #3** (a table of contents is a link aggregator, not teaching), so it takes the ordinary decision: **reject soft**, no cascade. That drops it from the pickable pool and removes its `ConceptResource` links, leaving its real sibling lessons approvable on their own. Then grade the remaining children normally and approve the ones that pass — the container ends up correct, just flatter than ideal.

  Two things **not** to do here, both of which look right and aren't:
  - **Not `action: "decompose"` on an index child.** Its links all point at rows that already exist, and `createChild` skips any child whose URL is already in the library — globally, by URL, without re-parenting (`src/lib/agents/decomposition/upsert-resource.ts`). So it would flip to `decomposed` and create **zero** children: an empty container, strictly worse than the index row you started with.
  - **Not "hand it to `/decompose` to rebuild the nesting".** Same reason: no API path re-parents existing rows, so re-decomposition cannot un-flatten anything. Re-parenting needs a direct DB write and is out of scope for this skill — flag it for a human if the nesting genuinely matters.

  **Requeue the root only for missing content, which is a separate defect.** If the landing page advertises chapters/units that have no row at all, `node --env-file=.env.local .claude/skills/decompose/scripts/decomp-db.cjs requeue <rootId>` moves the container back to `human_review` so `/decompose` can add them (new URLs are created normally; existing ones are skipped, so this is safe to run on a partially-built tree). Use the **production** `DATABASE_URL` override — the helper follows `DATABASE_URL`, not `OPERATOR_BASE_URL`. Requeuing sets `blocked: true`, so the root drops out of this queue until the decompose pass is done. Do this *after* rejecting the index rows, not instead of it.
- Genuinely unsure → **skip** and flag it; do not guess. We accept the residual risk and act on broken resources retroactively from user feedback.

## Steps

1. **Pull the batch.** `scripts/operator-curl.sh "/api/playground/pending-resources?limit=$ARGUMENTS" -s`. Each root carries `{ id, title, url, type, decompositionStatus, blocked, children:[…] }`.

2. **Grade each root** against the rubric by opening its page:
   - **Atomic root** (empty `children`) — open the `url`, grade, done.
   - **Container root** (non-empty `children`) — use **source-trust + sampling**, do **not** open every child:
     - Open the landing `url`; confirm it's a legitimate, free, no-login source and its structure matches the decomposition.
     - Sample a spread of real leaves: `node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/pending-review-db.cjs sample <rootId> 3` returns up to 3 atomic leaf URLs from anywhere in the subtree (direct children from the API are often themselves containers; the real leaves are deeper). Open them, confirm live + on-topic + real teaching content.
     - **Check the decomposition shape, not just the content.** A correct multi-chapter container nests — each chapter is its own `decomposed` sub-container and only true lessons are `atomic` leaves. Smell test: any `atomic` child whose page opens to an outline / table-of-contents linking to *other rows in this same container* is an exposed index page. Check every `atomic` child that looks like a chapter head (titles like "Introduction", "Basic Concepts", "N. <Chapter Name>", or a URL like `Intro<Something>`), not just the sampled leaves — one nested `decomposed` sibling elsewhere in the tree does **not** clear the others. Handle per **Exposed index pages** in the decision mapping instead of approving as-is.
     - **Compare the child list against the landing page's own table of contents.** A container that advertises nine chapters and holds three is incomplete — a different defect from an exposed index, with a different fix (requeue), and the two travel together often enough to be worth one look.
     - Extrapolate trust to the rest of the subtree. (This can miss a single broken leaf — accepted tradeoff.)

3. **Execute the decision** via the API:
   ```sh
   B=/api/playground/pending-resources
   # approve a container subtree
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"approve","cascade":true}'
   # approve a single atomic resource
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"approve"}'
   # reject (severity soft = quality | hard = broken link); add "cascade":true for a whole subtree
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"reject","severity":"soft"}'
   # send a misclassified atomic row (really a container) to the decompose queue
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"decompose"}'
   ```
   Skip blocked/unsure rows — issue no POST. (Optionally `... pending-review-db.cjs state <id>` to confirm a decision landed.)

   **Metadata corrections** (rubric #5, or any observed title/summary/difficulty error) go through the resources API *before* the approve/reject POST:
   ```sh
   # correct a bad duration guess (any of durationMin / title / summary / difficulty; whitelist-only)
   scripts/operator-curl.sh /api/playground/resources -s -XPATCH -H 'content-type: application/json' \
     -d '{"resourceId":"<id>","fields":{"durationMin":540}}'
   ```
   The response echoes the updated row plus flags: `embeddingStale: true` means a title/summary edit will be re-embedded by the backfill (no action needed); a `warning` means the row now sits over the attachable ceiling — apply the decision-mapping rule above (never approve it).

## Parallelize where possible

- Browser actions share one tab, so they're inherently sequential — but batch all navigations + extractions for a container's samples into **one `browser_batch`** call (navigate→get_page_text→navigate→get_page_text…) instead of separate round-trips.
- The batch fetch and the `pending-review-db.cjs sample` lookups for independent roots have no ordering dependency — fire them together.
- Execute the POST decisions for independent roots together once grading is done.

## Report

Output **only** the final table — do not narrate your reasoning per resource as you go. One row per resource processed:

| Resource | Link | Type | Decision | Reasoning |
|---|---|---|---|---|

`Decision` is one of: Approve · Approve (cascade) · Reject (soft) · Reject (hard) · Skip · Requeue (incomplete). A container with exposed index pages is **not** one decision: report the rejected index rows and the approved lessons as their own rows. Keep `Reasoning` to one line grounded in the rubric. After the table, add a one-line tally (approved / rejected / skipped) and call out any borderline calls worth a human's second look.
