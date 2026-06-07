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

3. **Apply via the API (same-origin POST from the localhost tab).** A decomposition needs ≥2 children. The API is on `localhost:3000`. When the rendered course page is on a public origin (e.g. `freecodecamp.org`), a cross-origin POST to localhost — even `mode: 'no-cors'` — is **blocked by Chrome's Private Network Access before it leaves the browser**: the request never reaches the server and the dev log stays silent (no POST line). So POST from a tab that is itself on the **localhost origin**.

   Bridge the extracted `children` across the cross-origin navigation with `window.name` — it survives cross-origin same-tab navigations (`localStorage` is per-origin, and `clipboard` needs transient user activation and tends to hang here):
   ```js
   // On the course page, after extraction:
   window.name = JSON.stringify({ resourceId: '<id>', action: 'decompose_manual', children });
   ```
   Then `navigate` the same tab to `http://localhost:3000/` and fire the POST there. The request stays open through concept derivation → child insert → embeddings (minutes for a large course — longer than the ~45 s CDP `javascript_tool` eval timeout), so **don't `await` it in one eval** (the eval times out while the request keeps running). Kick it off storing the outcome on a global, then read that global in short separate evals:
   ```js
   // On the localhost tab:
   const payload = JSON.parse(window.name);
   window.__r = null;
   fetch('/api/playground/decomposition-review', {
     method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
   }).then(async r => { window.__r = { status: r.status, body: (await r.text()).slice(0, 500) }; })
     .catch(e => { window.__r = { err: e.message }; });
   // later, in separate evals, read: window.__r
   // → { status: 200, body: '{"status":"decomposed","childrenCreated":N}' } when done
   ```
   Same-origin means the response is fully readable (status + body) — no opaque guessing — but still verify from the DB too. Do **not** re-fire while a request is in flight; poll instead.

4. **Verify.** Poll `node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/decomp-db.cjs verify <id>` until `parentStatus` is `decomposed`. Expect: `childCount` ≈ the number you extracted, `emptyConcepts: 0`, and `embedded` climbing to `childCount`. If it stays `human_review`/`childCount: 0`, either the POST never reached the server (no POST line in the dev log → a cross-origin/PNA block; confirm you fired it from the **localhost** tab, not the course tab) or it 500'd (a POST line with a 500 + stack → a very large course can still exceed limits). Read `window.__r` and the dev-server logs to tell which, then report.

## Report

Per id: extracted count, resulting `parentStatus` / `childCount` / `byType` / `embedded`, and any rows skipped (wrong state / not found). Be explicit when something didn't fully succeed.
