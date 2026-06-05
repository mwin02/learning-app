# javascript.info extraction recipe (Node)

`https://javascript.info/` is the full ordered tutorial outline as **static HTML** —
~202 single-segment article pages (`/intro`, `/variables`, `/arrow-functions`, …)
plus chapter landing pages (also real lesson pages). One server-rendered page, so
fetch + regex in Node; no browser.

Failure it works around: the auto doc-TOC router tries to LLM-select all ~200
sections in one call and runs out of output tokens. Here we extract the outline
deterministically and let `decompose_manual` derive concepts in chunks.

Validated end-to-end: 202 articles extracted → `decomposed`, 202 children, all
embedded, 0 empty concepts (~141s).

## Runnable: fetch → extract → POST

Save as `decompose-ji.cjs` and run from the repo root with the resource id:
`node decompose-ji.cjs <resourceId>` (re-queue first with `decomp-db.cjs requeue <id>`
if the row isn't `human_review`/`pending`). It only fetches the page and POSTs to
the local API — no DB access, no `--env-file` needed.

```js
const ID = process.argv[2];
if (!ID) { console.error('usage: node decompose-ji.cjs <resourceId>'); process.exit(1); }
const PAGE = 'https://javascript.info/';
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

(async () => {
  const html = await (await fetch(PAGE, { headers: { 'user-agent': 'Mozilla/5.0 LearningPathBot' } })).text();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set(); const children = []; let m;
  while ((m = re.exec(html)) !== null) {
    let url; try { url = new URL(m[1], PAGE); } catch { continue; }
    if (url.origin !== new URL(PAGE).origin) continue;
    const segs = url.pathname.split('/').filter(Boolean);
    // single-segment article pages only; drop non-lesson top-level pages
    if (segs.length !== 1 || /^(tutorial|ebook|translate|about|terms|privacy)$/.test(segs[0])) continue;
    url.hash = ''; const link = url.toString();
    if (seen.has(link)) continue; seen.add(link);
    const title = decode(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (title) children.push({ url: link, title });
  }
  console.error(`extracted ${children.length} articles`);
  const res = await fetch('http://localhost:3000/api/playground/decomposition-review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId: ID, action: 'decompose_manual', children }),
    signal: AbortSignal.timeout(300000),
  });
  console.log(res.status, await res.text());
})().catch((e) => { console.error('ERR', e.name, e.message); process.exit(1); });
```

Expect `200 {"resourceId":"…","status":"decomposed","childrenCreated":202}`, then
`decomp-db.cjs verify <id>`.

## Adapting to other server-rendered pages

Change `PAGE` and the link filter. The pattern is always: keep same-origin links
that are real lesson/article pages in document order, drop nav/footer/legal/edit
links, dedup, decode entities. Inspect the page's HTML first to find what
distinguishes article links (here: a single path segment).
