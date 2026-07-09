# node-toc route — server-rendered lesson lists (Node fetch, no browser)

For containers whose ordered lesson links sit in the **static HTML**. The auto
doc-TOC router fails on these two ways: a huge TOC blows its single-shot LLM
output budget (javascript.info ≈ 200 articles), or the row's URL is a **hub page**
that only links section pages, with the real lesson list one level deeper (MIT
OCW). Either way the fix is the same: extract the list deterministically in Node
and POST `decompose_manual` (concepts are derived server-side in chunks, so size
is never a problem).

Must be Node, not a browser: the cross-origin browser POST stalls on some doc
sites, and Node needs no extension.

## Hub pages: find the real list first

If the container URL yields no ordered lesson list but links section pages
(“Lecture Notes”, “Lessons”, “Chapters”, `pages/…`), fetch **that subpage** and
extract from there — the children still POST against the original resource id.
Confirm server-renderedness before writing the extractor:

```sh
curl -s <lesson-list-url> | grep -c '<a distinctive lesson href pattern>'
```

Worked example — MIT OCW `6-079-introduction-to-convex-optimization`: the course
landing page links only Syllabus/Readings/Lecture Notes/Assignments/Exams; the
`pages/lecture-notes/` subpage has a static table of 20 lectures, one
`/resources/mit6_079f09_lecNN/` link each, with rich per-lecture topic text in the
adjacent cell (use it as the child `title`).

## Runnable template (validated: javascript.info → 202 children, ~141s)

Save in the scratchpad, run `node <script>.cjs <resourceId>` from anywhere (it
only fetches the page and POSTs to the local API — no DB, no `--env-file`).
Adjust `PAGE` and the link filter per site; the invariant is always: same-origin
real-lesson links, document order, dedup, entity-decode, drop
nav/footer/legal/edit/anchor links.

```js
const ID = process.argv[2];
if (!ID) { console.error('usage: node decompose-toc.cjs <resourceId>'); process.exit(1); }
const PAGE = 'https://javascript.info/'; // ← the page holding the lesson list (may be a subpage of the resource URL)
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

(async () => {
  const html = await (await fetch(PAGE, { headers: { 'user-agent': 'Mozilla/5.0 LearningPathBot' } })).text();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set(); const children = []; let m;
  while ((m = re.exec(html)) !== null) {
    let url; try { url = new URL(m[1], PAGE); } catch { continue; }
    if (url.origin !== new URL(PAGE).origin) continue;
    // ── site-specific filter: what distinguishes a lesson link? ──
    // javascript.info: single-segment article pages, minus known non-lesson pages
    const segs = url.pathname.split('/').filter(Boolean);
    if (segs.length !== 1 || /^(tutorial|ebook|translate|about|terms|privacy)$/.test(segs[0])) continue;
    // ─────────────────────────────────────────────────────────────
    url.hash = ''; const link = url.toString();
    if (seen.has(link)) continue; seen.add(link);
    const title = decode(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (title) children.push({ url: link, title });
  }
  console.error(`extracted ${children.length} lessons`);
  const res = await fetch('http://localhost:3000/api/playground/decomposition-review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId: ID, action: 'decompose_manual', children }),
    signal: AbortSignal.timeout(300000),
  });
  console.log(res.status, await res.text());
})().catch((e) => { console.error('ERR', e.name, e.message); process.exit(1); });
```

Expect `200 {"resourceId":"…","status":"decomposed","childrenCreated":N}`, then
`decomp-db.cjs verify <id>`. For table-shaped lists (OCW), swap the generic `<a>`
scan for a row-wise extract so each child's title comes from the topic cell, not
the bare "(PDF)" link text.
