---
name: decompose-spa
description: Manually decompose SPA container resources (Khan Academy, etc.) in the decomposition review queue by rendering them in a headless browser, extracting the ordered lesson list, and POSTing decompose_manual. Takes one or more resource ids.
argument-hint: [resourceId ...]
disable-model-invocation: true
allowed-tools: Bash(node *), mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__select_browser, mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__javascript_tool, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__read_page
---

# Manually decompose SPA containers

**Bandaid.** Single-page-app courses (Khan Academy, etc.) render their lesson list client-side, so the scrape-based YouTube/doc-TOC routers see nothing and park them in `human_review`. This skill drives a real browser to render the SPA, harvests the ordered atomic lessons, and applies them via the `decompose_manual` action of the decomposition-review API. Replace this with the headless-render *agent* decomposer when it ships (post-Phase-3); until then a human runs this.

Resource ids to process: **$ARGUMENTS**

## Preconditions (check first, stop if unmet)

- Dev server running on `http://localhost:3000` with its env (incl. `DEV_AUTH=1` and Vertex creds — the API derives child concepts server-side). Probe: `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:3000/api/playground/decomposition-review -H 'content-type: application/json' -d '{"resourceId":"__probe__","action":"reject"}'` should print `404` with a JSON `NOT_FOUND` body.
- A Chrome browser connected via the Claude-in-Chrome extension. `list_connected_browsers`; if empty, ask the user to connect it. `select_browser` the device, then `tabs_context_mcp` with `createIfEmpty: true` and use that tab for everything.

## Per resource id

1. **Look up & gate.** `node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/decomp-db.cjs lookup <id>` (run from repo root). Confirm it exists and `decompositionStatus` is `human_review` or `pending` — skip and report otherwise (the API rejects non-queued rows with 409).

2. **Render & extract the ordered lessons.** Navigate the tab to the row's `url`. Extract the course's atomic learning resources **in learning order**, as `{ url, title, type? }`:
   - Keep only true atomic lessons (videos/articles). **Exclude** exercises, quizzes, unit tests, nav/login/search/social/“about”, and the page's own URL.
   - Dedup by URL. Clean titles (strip render noise like `"(Opens a modal)"`).
   - `type` is optional; the router infers it (YouTube→`video`, else `article`). Only set it when you're sure and it differs.
   - Many SPAs only link to sub-sections from the landing page (the per-lesson URLs live one level in) — drill into each section/unit and accumulate. Use `localStorage` to accumulate across same-origin navigations; return only counts from each `javascript_tool` call (it truncates long returns and blocks base64).
   - **Khan Academy recipe:** the course page lists units; the per-video URLs are on each unit page. Visit each unit, collect anchors whose path contains `/v/` (video) or `/a/` (article), drop `/e/` (exercise). See `references/khan-academy.md`.

3. **Apply via the API.** A decomposition needs ≥2 children. POST from the browser tab (cross-origin reads to localhost are CORS-blocked, but a `no-cors` simple request still reaches the server and `req.json()` parses any content-type):
   ```js
   fetch('http://localhost:3000/api/playground/decomposition-review', {
     method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' },
     body: JSON.stringify({ resourceId: '<id>', action: 'decompose_manual', children })
   })
   ```
   The response is opaque (can't be read) — that's expected; verify from the DB instead. The request runs server-side: concept derivation → child insert → embeddings, which can take a minute+ for a large course. Do **not** re-fire on no response; poll instead.

4. **Verify.** Poll `node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/decomp-db.cjs verify <id>` until `parentStatus` is `decomposed`. Expect: `childCount` ≈ the number you extracted, `emptyConcepts: 0`, and `embedded` climbing to `childCount`. If it stays `human_review`/`childCount: 0`, the POST likely 500'd — check the dev-server logs (a very large course can still exceed limits) and report.

## Report

Per id: extracted count, resulting `parentStatus` / `childCount` / `byType` / `embedded`, and any rows skipped (wrong state / not found). Be explicit when something didn't fully succeed.
