# anchor-toc route — one-page books with a fragment-link TOC (Node fetch)

For a real multi-chapter work rendered on **ONE page** whose table of contents is
in-page anchor links (`href="#chapter-…"`). Typical inhabitant: freeCodeCamp
"[Full Book]" handbooks parked by the book containment block ("book kept whole by
doc-TOC"). There are no per-chapter pages to link, so the children are **fragment
URLs on the parent page itself**: `<page>#<anchor>` — the same sub-page-unit idea
as YouTube `?t=` timestamp children.

Only `decompose_manual` accepts fragment children, under two API-enforced rules
(400 `INVALID_INPUT` otherwise):

- every fragment child must anchor onto the **parent's own page** (bare URL equal
  after canonicalization — trailing slash / tracking params / host case forgiven);
- each anchor at most **once** in the batch.

Automated routes still strip fragments; nothing changes outside this route.

## Method

1. **Fetch the page in Node** (`curl`-renderable — if the TOC only exists in a
   rendered SPA, this route doesn't apply).
2. **Harvest the page's own TOC links** (`href="#…"`), in document order, at
   **chapter level** — if the TOC nests sub-sections, keep only the top level.
   Standard extraction hygiene from SKILL.md otherwise: dedup, decode entities,
   clean titles.
3. **Slice the page text between consecutive anchors**: find each anchor target
   (`id="<anchor>"` / `name="<anchor>"`) in the HTML, take the text from it to the
   next chapter's target (last chapter runs to end), strip tags, count words.
4. **durationMin = words ÷ 200 wpm** (round, min 1) — real per-chapter durations,
   not the 20-min default.
5. **POST `decompose_manual`** with `{ url, title, durationMin }` per child
   (optionally a `summary` from the slice's first sentences). ≥ 2 children, in
   document order.

## Runnable template

Save in the scratchpad, run `node <script>.cjs <resourceId>`. Adjust `PAGE` and
the TOC filter per site.

```js
const ID = process.argv[2];
if (!ID) { console.error('usage: node anchor-toc.cjs <resourceId>'); process.exit(1); }
const PAGE = 'https://www.freecodecamp.org/news/…'; // ← the one-page book (must equal the resource URL)
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const strip = (s) => decode(s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

(async () => {
  const html = await (await fetch(PAGE, { headers: { 'user-agent': 'Mozilla/5.0 LearningPathBot' } })).text();
  // 1. TOC anchors, document order. ── site-specific filter: keep chapter-level only ──
  const toc = []; const seen = new Set();
  const re = /<a\b[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const anchor = m[1]; const title = strip(m[2]);
    if (!title || seen.has(anchor)) continue;
    // e.g. freeCodeCamp chapter anchors look like "chapter-1-…" — adjust per site:
    if (!/^chapter-/.test(anchor)) continue;
    seen.add(anchor); toc.push({ anchor, title });
  }
  // 2. Slice text between consecutive anchor targets → word-count durations.
  const pos = toc.map(({ anchor }) => {
    const t = new RegExp(`\\bid="${anchor}"|\\bname="${anchor}"`).exec(html);
    return t ? t.index : -1;
  });
  const children = toc.map(({ anchor, title }, i) => {
    const start = pos[i]; const end = pos.slice(i + 1).find((p) => p > start) ?? html.length;
    const words = start < 0 ? 0 : strip(html.slice(start, end)).split(' ').length;
    return {
      url: `${PAGE}#${anchor}`,
      title,
      durationMin: Math.max(1, Math.round(words / 200)),
    };
  });
  console.error(`extracted ${children.length} chapters`, children.map((c) => `${c.title} (${c.durationMin}m)`));
  const res = await fetch('http://localhost:3000/api/playground/decomposition-review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId: ID, action: 'decompose_manual', children }),
    signal: AbortSignal.timeout(300000),
  });
  console.log(res.status, await res.text());
})().catch((e) => { console.error('ERR', e.name, e.message); process.exit(1); });
```

Sanity-check the extraction **before** the POST fires (comment the fetch out on a
dry run if unsure): chapter count matches the visible TOC, titles clean, durations
plausible (a real chapter is usually 10–60 min, not 1). A `durationMin` of 1
across the board means the anchor-target regex found nothing — check how the site
writes its heading ids.

Expect `200 {"…","status":"decomposed","childrenCreated":N}`, then
`decomp-db.cjs verify <id>` per stage 3. A 400 `INVALID_INPUT` with `crossPage`
or `duplicates` in the details means the harvest broke a rule above — fix the
filter, don't force it.
