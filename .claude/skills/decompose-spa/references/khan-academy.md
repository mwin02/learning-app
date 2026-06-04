# Khan Academy extraction recipe

Khan course pages (`/math/<course>`) list **units**; the per-video URLs live on
each **unit** page (`/math/<course>/<unit>`). Content paths encode the type:
`/v/` video, `/a/` article, `/e/` exercise (drop exercises).

Worked end-to-end on `https://www.khanacademy.org/math/linear-algebra`
(3 units → 138 ordered videos, 4 exercises dropped).

## 1. Get the unit URLs (from the course page)

```js
JSON.stringify([...document.querySelectorAll('a[href]')]
  .map(a => ({ href: a.getAttribute('href') || '', text: (a.textContent||'').trim() }))
  .filter(a => /^\/math\/[a-z0-9-]+\/[a-z0-9-]+$/.test(a.href) && !/\/(v|a|e)\//.test(a.href) && a.text && a.text !== 'Community questions')
  .map(a => new URL(a.href, location.origin).toString()))
```

## 2. Per unit: accumulate content into localStorage

Navigate to each unit URL, then run this. It appends `/v/` + `/a/` items
(drops `/e/`), dedups globally, strips `"(Opens a modal)"`, and returns only
counts (the tool truncates long returns and blocks base64, so never return the
full array):

```js
JSON.stringify((() => {
  const KEY = '__spa_kids';
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, '[]'); // init once
  const store = JSON.parse(localStorage.getItem(KEY) || '[]');
  const seen = new Set(store.map(x => x.url));
  let added = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const km = href.match(/\/(v|a|e)\//);
    if (!km || km[1] === 'e') continue;            // skip non-content + exercises
    const url = new URL(href, location.origin).toString();
    if (seen.has(url)) continue; seen.add(url);
    const title = (a.textContent || '').replace(/\s*\(Opens a modal\)\s*$/, '').trim();
    if (!title) continue;
    store.push({ url, title, type: km[1] === 'v' ? 'video' : 'article' });
    added++;
  }
  localStorage.setItem(KEY, JSON.stringify(store));
  return { unit: location.pathname, added, total: store.length };
})())
```

Reset `__spa_kids` to `'[]'` before starting a new resource.

## 3. POST and verify

```js
JSON.stringify((() => {
  const children = JSON.parse(localStorage.getItem('__spa_kids') || '[]');
  fetch('http://localhost:3000/api/playground/decomposition-review', {
    method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ resourceId: '<id>', action: 'decompose_manual', children }),
  });
  return { fired: true, childrenCount: children.length };
})())
```

Then poll `decomp-db.cjs verify <id>` until `parentStatus: "decomposed"`.
Afterwards, clean up: `localStorage.removeItem('__spa_kids')`.
