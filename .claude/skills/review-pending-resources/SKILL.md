---
name: review-pending-resources
description: Browser-review resources in the pending_review approval queue against a content-quality rubric, then approve/reject them via the pending-resources API. Takes the number of queue roots to process; samples children for container resources. Returns a decision table.
argument-hint: [count]
disable-model-invocation: true
allowed-tools: Bash(curl *), Bash(node *), mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__select_browser, mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__browser_batch, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__read_page
---

# Review the pending_review approval queue

Resources discovered by the web fallback land as `status='pending_review'` — usable in the run that found them, but hidden from future runs by the gate until approved. This skill works that queue **as a reviewer**: pull a batch, open each resource in a real browser, grade it against the rubric below (so we catch what discovery's URL-only validators can't — login walls, parked pages, metadata mismatches), then **execute** the decision via the pending-resources API. This is the human/POC stand-in for the autonomous review agent.

Number of queue **roots** to process this run: **$ARGUMENTS** (default 10 if empty). Note `limit` counts top-level roots, not flattened resources — one root may be a large container subtree.

## Preconditions (check first, stop if unmet)

- Dev server on `http://localhost:3000` with its env (incl. `DEV_AUTH=1`). Probe: `curl -s -o /dev/null -w "%{http_code}" "localhost:3000/api/playground/pending-resources?limit=1"` → `200`. A `404` means `DEV_AUTH` is off (the route 404s when unauthed); ask the user to start it with `DEV_AUTH=1`.
- A Chrome browser connected via the Claude-in-Chrome extension. `list_connected_browsers`; if empty, ask the user to connect it. `select_browser` the device, then `tabs_context_mcp` with `createIfEmpty: true` and use that one tab for everything.

## Rubric (grade each resource against the actual rendered page)

1. **Live & renders** — loads to real content, not a 404/410/parked/error page. (If `get_page_text` is empty, the page may be a JS-rendered SPA — confirm with `read_page` before calling it dead.)
2. **No access barrier** — main content readable/watchable without creating an account, logging in, or paying. Free-but-signup (e.g. email-gated videos) still fails this.
3. **Teaches directly** — the page itself teaches the topic; not a listicle, link aggregator, marketing/sales/signup landing page.
4. **Metadata accuracy** — page matches the stored title / type / difficulty / conceptsTaught.

### Decision mapping

- All pass → **approve** (atomic root) or **approve cascade** (container — promotes the whole subtree).
- Fails #1, broken/dead/removed → **reject hard**.
- Fails #2/#3/#4, page works but violates a quality rule or is misrepresented → **reject soft**.
- `blocked: true` in the queue (decompositionStatus `pending`/`human_review`) → **skip**, flag "resolve in Human review first" (the API 409s on these anyway).
- Genuinely unsure → **skip** and flag it; do not guess. We accept the residual risk and act on broken resources retroactively from user feedback.

## Steps

1. **Pull the batch.** `curl -s "localhost:3000/api/playground/pending-resources?limit=$ARGUMENTS"`. Each root carries `{ id, title, url, type, decompositionStatus, blocked, children:[…] }`.

2. **Grade each root** against the rubric by opening its page:
   - **Atomic root** (empty `children`) — open the `url`, grade, done.
   - **Container root** (non-empty `children`) — use **source-trust + sampling**, do **not** open every child:
     - Open the landing `url`; confirm it's a legitimate, free, no-login source and its structure matches the decomposition.
     - Sample a spread of real leaves: `node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/pending-review-db.cjs sample <rootId> 3` returns up to 3 atomic leaf URLs from anywhere in the subtree (direct children from the API are often themselves containers; the real leaves are deeper). Open them, confirm live + on-topic + real teaching content.
     - Extrapolate trust to the rest of the subtree. (This can miss a single broken leaf — accepted tradeoff.)

3. **Execute the decision** via the API:
   ```sh
   B=localhost:3000/api/playground/pending-resources
   # approve a container subtree
   curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"approve","cascade":true}'
   # approve a single atomic resource
   curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"approve"}'
   # reject (severity soft = quality | hard = broken link); add "cascade":true for a whole subtree
   curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"reject","severity":"soft"}'
   ```
   Skip blocked/unsure rows — issue no POST. (Optionally `... pending-review-db.cjs state <id>` to confirm a decision landed.)

## Parallelize where possible

- Browser actions share one tab, so they're inherently sequential — but batch all navigations + extractions for a container's samples into **one `browser_batch`** call (navigate→get_page_text→navigate→get_page_text…) instead of separate round-trips.
- The batch `curl` and the `pending-review-db.cjs sample` lookups for independent roots have no ordering dependency — fire them together.
- Execute the POST decisions for independent roots together once grading is done.

## Report

Output **only** the final table — do not narrate your reasoning per resource as you go. One row per resource processed:

| Resource | Link | Type | Decision | Reasoning |
|---|---|---|---|---|

`Decision` is one of: Approve · Approve (cascade) · Reject (soft) · Reject (hard) · Skip. Keep `Reasoning` to one line grounded in the rubric. After the table, add a one-line tally (approved / rejected / skipped) and call out any borderline calls worth a human's second look.
