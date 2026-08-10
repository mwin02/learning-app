---
name: decompose
description: Work the decomposition review queue end-to-end - triage each queued container (accept_atomic / reject / decompose), pick the right decomposition route (force, node-toc, browser-spa, video-chapters), execute it via the decomposition-review API, and verify. Takes resource ids, or a count to pull from the queue. Replaces decompose-large-page and decompose-spa.
argument-hint: [resourceId ... | count]
disable-model-invocation: true
allowed-tools: Bash(node *), Bash(scripts/operator-curl.sh *), Bash(curl *), mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__select_browser, mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__browser_batch, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__read_page, mcp__Claude_in_Chrome__javascript_tool
---

# Work the decomposition review queue

Container resources the automatic routers couldn't decompose park as
`decompositionStatus ∈ {human_review, pending}` — unpickable until decided. This
skill works that queue **as the decider**, per resource: **triage** (is this worth
keeping, and whole or exploded?) → **route** (which extraction technique fits the
page?) → **execute** via the `decomposition-review` API → **verify**. It is the
human/POC stand-in for the headless-render decomposition agent (post-Phase-3);
like `review-pending-resources` it both judges *and* executes.

Input: **$ARGUMENTS** — either explicit resource ids, or a single number = how many
queued rows to pull (default 5 if empty).

## Preconditions

- **The API target, configured and reachable.** Every admin call goes through
  `scripts/operator-curl.sh <path> [curl args]`, which supplies the base URL and the admin
  credential from `.env.local`; it has **no localhost default** and refuses to run
  unconfigured. Probe:
  `scripts/operator-curl.sh /api/playground/decomposition-review -s -o /dev/null -w "%{http_code}" -XPOST -H 'content-type: application/json' -d '{"resourceId":"__probe__","action":"reject"}'`
  → `404` with a JSON `NOT_FOUND` body (fetch it without `-o /dev/null` to tell the two
  404s apart). A **plain-text** `404` means the operator token is missing/wrong or its
  `User` row is not `role='admin'` — the admin wrapper 404s rather than 401 by design;
  stop and see `operator-tooling.md`. The service also needs Vertex creds, since the
  API derives child concepts server-side.
- **Say which service you are deciding against, in your first message.** The script prints
  `[operator-curl] POST <base><path>` to stderr on every call, with a `⚠ REMOTE` marker off
  localhost — read it off the probe. Remote means production and every write is real.
- **The `decomp-db.cjs` helper is a separate target** — it connects to Postgres directly and
  follows `DATABASE_URL`, not `OPERATOR_BASE_URL`, so the two can disagree. It prints
  `[db] host:port/dbname` to stderr on every run; confirm it is the database behind the API
  base you probed. Pointed at the wrong one the queue comes back **empty**, not failing —
  "nothing to decompose" is the symptom.
- A connected Chrome (Claude-in-Chrome) is needed **only for the browser-spa route
  and for triaging pages `curl` can't render**. Don't demand it up front; if a
  resource turns out to need it and no browser is connected, skip that resource and
  flag it in the report.
- **One resource at a time.** Decomposition fires many parallel Vertex
  concept-derivation calls; concurrent runs stall on rate limits (no per-call
  timeout). Never run two decompositions at once.

## The helper script

`node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/decomp-db.cjs <cmd>` (repo root):

- `queue [n]` — the n oldest queued rows (id, title, url, type, topic, durationMin, status)
- `lookup <id>` — one row's url/topic/type/durationMin/status
- `verify <id>` — post-decomposition state: parentStatus, childCount, byType, embedded, emptyConcepts
- `requeue <id>` — move a decided row (e.g. an earlier reject) back to `human_review`
  so it can be re-decided; the API only moves rows *out* of the queue (409 otherwise)

## Stage 1 — Triage (per resource)

Look at the actual page before deciding. Try cheap first: `curl -s <url>` and read
the HTML — most triage calls (paywall interstitial, single article, visible lesson
list) are decidable from that. If the HTML is an empty JS shell, open it in the
browser (`get_page_text`, then `read_page` if empty) before calling it dead.

| Verdict | When | API action |
|---|---|---|
| **Accept atomic** | Genuinely ONE lesson/article/video (the router's container guess was wrong) and `durationMin` ≤ 300 (`MAX_ATTACHABLE_DURATION_MIN`). Over-ceiling accepts are a deliberate operator override — justify in the report. Also the right verdict for `book` rows parked with reason "book kept whole by doc-TOC …" when the page really is ONE chapter/section mistyped as `book` — decompose() parks every atomic book outcome regardless of duration (text durations are unverified LLM guesses that lowball whole books), so a genuine single chapter lands here and just needs your confirmation. A book that IS an entire work is `reject` (monolithic, no per-unit URLs) or stage-2 decompose. | `accept_atomic` |
| **Reject** | Paywalled / login-gated (free-but-signup counts), dead/parked, non-teaching (marketing, link aggregator), or **structurally undecomposable**: a real multi-unit work whose site exposes no per-unit URLs — e.g. a book page offering only one monolithic PDF, or a chapterless multi-hour video. Also: content whose concepts are out of scope for its `topic`. | `reject` |
| **Decompose** | A real container — ordered multi-unit course/tutorial/book/playlist — whose units have harvestable distinct URLs (a `?t=` timestamp variant counts). | stage 2 |
| **Skip** | Genuinely unsure, or needs a browser that isn't connected. No POST; flag it. | — |

Execute accept/reject immediately:

```sh
B=/api/playground/decomposition-review
scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"accept_atomic"}'
scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"reject"}'
```

(`reject` sets `unsupported` — the row stays as an unpickable record. The API 409s
on rows not currently queued; `requeue` first if you're deliberately re-deciding one.)

## Stage 2 — Route selection (decompose verdicts only)

Pick the **first** matching route:

| Signal | Route | How |
|---|---|---|
| YouTube **playlist** URL (`list=` param) — parked only because it tripped the oversize gate (> 50 auto children) | **force** | `scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"decompose","force":true}'` — the automatic router knows how; no extraction needed. |
| Single long YouTube **video** with timestamp chapters in its description | **video-chapters** | Node script via the YouTube Data API; children are `&t=NNNs` URLs with real per-chapter durations. See [references/video-chapters.md](references/video-chapters.md). |
| A real **multi-chapter work on a single page** whose own TOC is in-page fragment links (`href="#…"`) — the one-page book (typical for `book` rows parked as "book kept whole by doc-TOC") | **anchor-toc** | Node fetch → harvest the TOC anchors → slice text between them for real durations → POST `decompose_manual` with `<page>#<anchor>` children. See [references/anchor-toc.md](references/anchor-toc.md). |
| Lesson links present in the **static HTML** (verify: `curl -s <url> \| grep` a known lesson href). Includes **hub pages** whose lesson list lives one section deeper — find the subpage (e.g. OCW `pages/lecture-notes/`) and extract from *there*. | **node-toc** | Node fetch + regex → POST `decompose_manual`. See [references/node-toc.md](references/node-toc.md). |
| Client-rendered SPA (Khan Academy, etc.) — `curl` HTML has no lesson links but the rendered page does | **browser-spa** | Chrome harvest, `window.name` bridge, POST from a localhost tab. See [references/browser-spa.md](references/browser-spa.md). |

Route notes:

- `decompose_manual` needs **≥ 2 children**, each `{ url, title }` (+ optional
  `type`, `durationMin`, `summary`), **in learning order**. Concepts are derived
  server-side in chunks, so child-count is never a token problem.
- Extraction hygiene (all routes): keep only true atomic lessons — exclude
  exercises/quizzes/nav/login/legal/"edit on GitHub"/in-page anchors and the page's
  own URL; dedup by URL; decode entities; preserve document order; clean titles.
  (Exception: on the **anchor-toc** route, same-page fragment links are the
  children by design — the API accepts `<parent-page>#<anchor>` URLs from
  `decompose_manual` only, and 400s any fragment onto a *different* page or a
  repeated anchor.)
- Node routes POST from Node with a long `AbortSignal.timeout` (expect minutes for
  100+ children). The POST returns `{ status, childrenCreated }` synchronously.
- The whole operation is **slow & local-only** (exceeds serverless limits) — that's
  expected; don't try to parallelize it.

## Stage 3 — Verify & report

After every decompose (any route): `decomp-db.cjs verify <id>` → expect
`parentStatus: "decomposed"`, `childCount` ≈ extracted, `emptyConcepts: 0`,
`embedded` == `childCount` (poll if the POST path was fire-and-forget). If it stays
queued with `childCount: 0`, the POST never landed (browser route: PNA block — see
the browser-spa reference) or 500'd (check the dev-server log), diagnose before
moving on.

### Post-decomposition attach hook (rejudge-sourced-for)

The review API runs a **`rejudgeForDemandingPaths` hook inline after every success
shape** (`decompose`, `decompose_manual`, and `accept_atomic`) — see
`src/lib/agents/decomposition/rejudge-sourced-for.ts`. It offers the now-pickable
rows (a decomposition's atomic children, or the accepted row itself) back to the
concepts of any Path that **demanded** the container, and the judge attaches the
keepers as `ConceptResource` links (`role` ∈ `teaches` / `uses`). So decomposition
**can and often does auto-attach children to existing Paths** — the old "only
creates library rows" claim is wrong.

- **Trigger & scope:** only fires when the container has `ResourceSourcedFor`
  provenance (a path's demand sourced it). No provenance → clean no-op, 0
  attachments. It is strictly demand-scoped: only paths that demanded the
  container, never the whole library. Children route by pgvector distance to each
  demanding path's **full** concept list (not just the sourcing concept), so a
  child can attach to several concepts across a path.
- **Best-effort:** the decomposition is already committed; a hook failure is
  reported, not fatal. The API response carries the outcome in a **`rejudge`**
  field: `{ pairs, candidates, attachments: [{ pathId, conceptSlug, routed,
  attached }] }`. `attached: 0` with `routed > 0` means the judge saw candidates
  but rejected them — normal, not a failure.
- **Capture it:** the browser-spa route's `window.__r` is the response body — read
  it after the POST resolves to see `rejudge`. If it comes back null (lost across
  navigation), reconstruct from the DB: `ConceptResource` rows whose `resourceId`
  is one of the parent's children, with `createdAt` matching the run. Report the
  attachments (path topic + concept titles) alongside the decompose result.
- **Watch for:** a mis-tagged or duplicate container (wrong `topic`, or a
  near-duplicate of an already-decomposed course) will propagate that mistake into
  a **live path attachment**, not just a stray library row — flag those for the
  operator with extra weight now that attach is automatic.

Output **only** a final table — no per-resource narration:

| Resource | Link | Triage | Route | Children | Result |
|---|---|---|---|---|---|

`Triage` ∈ Accept atomic · Reject · Decompose · Skip. `Result` is the verified
outcome (`decomposed 23/23 embedded`, `unsupported`, `atomic`, or the failure).
After the table: a one-line tally, **any Path attachments the rejudge hook made**
(from the `rejudge` field / DB — path topic + concept, and the total), and any
borderline calls worth a second look.
