# video-chapters route — one long video with timestamp chapters (Node, no browser)

For a **single** YouTube video too long to attach whole (over the 300-min
`MAX_ATTACHABLE_DURATION_MIN` ceiling — the "atomic but oversize" park reason)
whose description carries an ordered chapter list ("0:00 Intro / 12:34 Vectors
/ …" — the freeCodeCamp/LunarTech course-video pattern). Children are the **same
video at chapter offsets**: `watch?v=<id>&t=<sec>s`. URL normalization
(`normalize-url.ts`) strips only tracking params, so `t=` survives and each
chapter is a distinct, dedup-safe URL; the parent (`watch?v=<id>`, no `t=`)
never collides with them.

Triage first: if the description has **no usable chapter lines** (or only 1),
the video is structurally undecomposable → `reject` (or operator
`accept_atomic` if it's genuinely worth keeping whole).

Real durations matter here — compute each chapter's `durationMin` from the gap
to the next timestamp (the manual router would otherwise default every child to
20 min). Get description + total length from the YouTube Data API (the app
already ships a key as `YOUTUBE_API_KEY` in `.env.local`).

## Runnable template (needs `--env-file=.env.local` for the API key)

`node --env-file=.env.local decompose-chapters.cjs <resourceId> <videoId>` from
the repo root. Review the printed chapter list — the regex can catch stray
timestamps in prose (credits, "at 1:23:45 we…"); if the extraction looks wrong,
fix the filter, don't POST garbage.

```js
const [ID, VID] = process.argv.slice(2);
if (!ID || !VID) { console.error('usage: node decompose-chapters.cjs <resourceId> <videoId>'); process.exit(1); }
const KEY = process.env.YOUTUBE_API_KEY?.trim();
if (!KEY) { console.error('YOUTUBE_API_KEY not set'); process.exit(1); }

const toSec = (ts) => ts.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
const isoToSec = (iso) => {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return (+(m?.[1] ?? 0)) * 3600 + (+(m?.[2] ?? 0)) * 60 + (+(m?.[3] ?? 0));
};

(async () => {
  const api = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${VID}&key=${KEY}`;
  const item = (await (await fetch(api)).json()).items?.[0];
  if (!item) { console.error('video not found'); process.exit(1); }
  const totalSec = isoToSec(item.contentDetails.duration);

  // One chapter per description line that contains a timestamp. Title = the line
  // minus the timestamp, surrounding brackets, and leading emoji/bullet cruft.
  const chapters = [];
  for (const line of item.snippet.description.split('\n')) {
    const m = line.match(/(\d{1,2}:)?\d{1,2}:\d{2}/);
    if (!m) continue;
    const title = line.replace(m[0], '').replace(/[()\[\]]/g, ' ')
      .replace(/^[^\p{L}\p{N}]+/u, '') // leading emoji/bullets/dashes/colons
      .replace(/\s+/g, ' ').trim();
    if (title) chapters.push({ sec: toSec(m[0]), title });
  }
  chapters.sort((a, b) => a.sec - b.sec);

  const children = chapters.map((c, i) => {
    const endSec = i + 1 < chapters.length ? chapters[i + 1].sec : totalSec;
    return {
      url: `https://www.youtube.com/watch?v=${VID}&t=${c.sec}s`,
      title: c.title,
      type: 'video',
      durationMin: Math.max(1, Math.round((endSec - c.sec) / 60)),
    };
  });
  console.error(`extracted ${children.length} chapters of ${Math.round(totalSec / 60)}min total:`);
  children.forEach((c) => console.error(`  ${c.durationMin}m  ${c.title}`));
  if (children.length < 2) { console.error('fewer than 2 chapters — reject/accept instead'); process.exit(1); }

  const res = await fetch('http://localhost:3000/api/playground/decomposition-review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId: ID, action: 'decompose_manual', children }),
    signal: AbortSignal.timeout(300000),
  });
  console.log(res.status, await res.text());
})().catch((e) => { console.error('ERR', e.name, e.message); process.exit(1); });
```

Then `decomp-db.cjs verify <id>` — expect `childCount` == chapter count, all
`video`, `emptyConcepts: 0`.

Caveats:

- Chapter lines sometimes label sections, not lessons ("PART 2 — 3:00:00").
  If the printed list looks wrong, re-run with a tightened filter rather than
  accepting a bad split.
- If the description has no chapters but the video player shows them, they come
  from user comments or auto-chapters the Data API doesn't expose — treat as
  chapterless (reject) rather than scraping the watch page.
