---
name: decompose
description: Work the decomposition review queue end-to-end - triage each queued container (accept_atomic / reject / decompose), pick the right decomposition route (force, node-toc, browser-spa, video-chapters), execute it via the decomposition-review API, and verify. Takes resource ids, or a count to pull from the queue. Replaces decompose-large-page and decompose-spa.
argument-hint: [resourceId ... | count]
disable-model-invocation: true
allowed-tools: Bash(node *), Bash(curl *), mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__select_browser, mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__browser_batch, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__read_page, mcp__Claude_in_Chrome__javascript_tool
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

- Dev server on `http://localhost:3000` with its env (incl. `DEV_AUTH=1` and Vertex
  creds — the API derives child concepts server-side). Probe:
  `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:3000/api/playground/decomposition-review -H 'content-type: application/json' -d '{"resourceId":"__probe__","action":"reject"}'`
  → `404` with a JSON `NOT_FOUND` body. A plain `404` page / connection refused means
  the server or `DEV_AUTH` is missing — stop and ask.
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
| **Accept atomic** | Genuinely ONE lesson/article/video (the router's container guess was wrong) and `durationMin` ≤ 300 (`MAX_ATTACHABLE_DURATION_MIN`). Over-ceiling accepts are a deliberate operator override — justify in the report. | `accept_atomic` |
| **Reject** | Paywalled / login-gated (free-but-signup counts), dead/parked, non-teaching (marketing, link aggregator), or **structurally undecomposable**: a real multi-unit work whose site exposes no per-unit URLs — e.g. a book page offering only one monolithic PDF, or a chapterless multi-hour video. Also: content whose concepts are out of scope for its `topic`. | `reject` |
| **Decompose** | A real container — ordered multi-unit course/tutorial/book/playlist — whose units have harvestable distinct URLs (a `?t=` timestamp variant counts). | stage 2 |
| **Skip** | Genuinely unsure, or needs a browser that isn't connected. No POST; flag it. | — |

Execute accept/reject immediately:

```sh
B=localhost:3000/api/playground/decomposition-review
curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"accept_atomic"}'
curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"reject"}'
```

(`reject` sets `unsupported` — the row stays as an unpickable record. The API 409s
on rows not currently queued; `requeue` first if you're deliberately re-deciding one.)

## Stage 2 — Route selection (decompose verdicts only)

Pick the **first** matching route:

| Signal | Route | How |
|---|---|---|
| YouTube **playlist** URL (`list=` param) — parked only because it tripped the oversize gate (> 50 auto children) | **force** | `curl -s -XPOST "$B" -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"decompose","force":true}'` — the automatic router knows how; no extraction needed. |
| Single long YouTube **video** with timestamp chapters in its description | **video-chapters** | Node script via the YouTube Data API; children are `&t=NNNs` URLs with real per-chapter durations. See [references/video-chapters.md](references/video-chapters.md). |
| Lesson links present in the **static HTML** (verify: `curl -s <url> \| grep` a known lesson href). Includes **hub pages** whose lesson list lives one section deeper — find the subpage (e.g. OCW `pages/lecture-notes/`) and extract from *there*. | **node-toc** | Node fetch + regex → POST `decompose_manual`. See [references/node-toc.md](references/node-toc.md). |
| Client-rendered SPA (Khan Academy, etc.) — `curl` HTML has no lesson links but the rendered page does | **browser-spa** | Chrome harvest, `window.name` bridge, POST from a localhost tab. See [references/browser-spa.md](references/browser-spa.md). |

Route notes:

- `decompose_manual` needs **≥ 2 children**, each `{ url, title }` (+ optional
  `type`, `durationMin`, `summary`), **in learning order**. Concepts are derived
  server-side in chunks, so child-count is never a token problem.
- Extraction hygiene (all routes): keep only true atomic lessons — exclude
  exercises/quizzes/nav/login/legal/"edit on GitHub"/in-page anchors and the page's
  own URL; dedup by URL; decode entities; preserve document order; clean titles.
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

Note: decomposition only creates library rows — it does **not** attach children to
any existing Path (attachment happens at map build / remediation / `map-edit
attach_resource`). Mention in the report when new children look highly relevant to
an existing path so the operator can follow up.

Output **only** a final table — no per-resource narration:

| Resource | Link | Triage | Route | Children | Result |
|---|---|---|---|---|---|

`Triage` ∈ Accept atomic · Reject · Decompose · Skip. `Result` is the verified
outcome (`decomposed 23/23 embedded`, `unsupported`, `atomic`, or the failure).
After the table: a one-line tally and any borderline calls worth a second look.
