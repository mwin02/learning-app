# browser-spa route — client-rendered courses (Chrome required)

For SPA containers (Khan Academy, etc.) whose lesson list only exists after
client-side rendering — `curl` returns an empty JS shell, so the Node route gets
nothing. Drive the connected Chrome: render, harvest the ordered lessons, then
POST `decompose_manual` **from a localhost tab** (see the PNA trap below).

Setup: `list_connected_browsers` → `select_browser` → `tabs_context_mcp` with
`createIfEmpty: true`; use that one tab for everything.

## 1. Harvest the ordered lessons

Navigate the tab to the row's `url`. Extract atomic lessons **in learning order**
as `{ url, title, type? }`:

- Keep only true lessons (videos/articles). Exclude exercises, quizzes, unit
  tests, nav/login/search/social/"about", and the page's own URL.
- Dedup by URL; clean titles (strip render noise like `"(Opens a modal)"`).
- `type` is optional (the router infers YouTube→`video`, else `article`).
- Many SPAs list only **units** on the landing page, with per-lesson URLs one
  level in — drill into each unit and accumulate. Use `localStorage` to
  accumulate across same-origin navigations, and return **only counts** from each
  `javascript_tool` eval (long returns get truncated; base64 is blocked).

### Khan Academy recipe (worked: math/linear-algebra → 3 units, 138 videos)

Unit URLs from the course page (`/math/<course>`):

```js
JSON.stringify([...document.querySelectorAll('a[href]')]
  .map(a => ({ href: a.getAttribute('href') || '', text: (a.textContent||'').trim() }))
  .filter(a => /^\/math\/[a-z0-9-]+\/[a-z0-9-]+$/.test(a.href) && !/\/(v|a|e)\//.test(a.href) && a.text && a.text !== 'Community questions')
  .map(a => new URL(a.href, location.origin).toString()))
```

Per unit page — content paths encode type: `/v/` video, `/a/` article, `/e/`
exercise (drop). Init `localStorage.setItem('__spa_kids','[]')` once, then:

```js
JSON.stringify((() => {
  const store = JSON.parse(localStorage.getItem('__spa_kids') || '[]');
  const seen = new Set(store.map(x => x.url));
  let added = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const km = href.match(/\/(v|a|e)\//);
    if (!km || km[1] === 'e') continue;
    const url = new URL(href, location.origin).toString();
    if (seen.has(url)) continue; seen.add(url);
    const title = (a.textContent || '').replace(/\s*\(Opens a modal\)\s*$/, '').trim();
    if (!title) continue;
    store.push({ url, title, type: km[1] === 'v' ? 'video' : 'article' });
    added++;
  }
  localStorage.setItem('__spa_kids', JSON.stringify(store));
  return { unit: location.pathname, added, total: store.length };
})())
```

## 2. POST from a localhost tab (the PNA trap)

A POST to `localhost:3000` from a public-origin tab — even `mode: 'no-cors'` — is
**blocked by Chrome's Private Network Access before it leaves the browser**: no
request reaches the server, the dev log stays silent. So bridge the payload across
a same-tab navigation with `window.name` (survives cross-origin navigation;
`localStorage` is per-origin and clipboard hangs without user activation):

```js
// still on the course page:
window.name = JSON.stringify({ resourceId: '<id>', action: 'decompose_manual',
  children: JSON.parse(localStorage.getItem('__spa_kids') || '[]') });
localStorage.removeItem('__spa_kids');
```

Then `navigate` the same tab to `http://localhost:3000/` and fire there. The
request stays open through concept derivation + inserts + embeddings (minutes for
a large course — longer than the ~45s eval timeout), so **don't `await` it in one
eval**; stash the outcome on a global and poll it in short separate evals:

```js
const payload = JSON.parse(window.name);
window.__r = null;
fetch('/api/playground/decomposition-review', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
}).then(async r => { window.__r = { status: r.status, body: (await r.text()).slice(0, 2000) }; })
  .catch(e => { window.__r = { err: e.message }; });
// later evals: window.__r  → { status: 200, body: '{"status":"decomposed","childrenCreated":N,"rejudge":{...}}' }
```

The body also carries a **`rejudge`** field — the post-decomposition attach hook's
result (`{ pairs, candidates, attachments: [...] }`); see Stage 3 in SKILL.md. Read
it here for the Path attachments; **don't slice it off** (hence the 2000-char cap).
If `window.__r` comes back null (the promise didn't survive a navigation),
reconstruct the attachments from the DB.

Do **not** re-fire while a request is in flight; poll. Verify from the DB too
(`decomp-db.cjs verify <id>`). If it stays queued with `childCount: 0` and the dev
log shows no POST line, the request was PNA-blocked — confirm you fired from the
**localhost** tab.
