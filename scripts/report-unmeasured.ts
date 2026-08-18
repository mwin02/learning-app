// What is left after the Khan browser backfill, and what evidence exists for each kind.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/report-unmeasured.ts
//   … --limit=12          # examples shown per group
//
// READ-ONLY. This exists so the residue is a decidable list rather than a count: B4's rule
// is that the unknown number is reported, and a number nobody can act on is only half of
// that. Every group below says what measurement IS available, since that is what determines
// whether a rule could be written for it.
//
// The classification is not re-derived here — it calls the same `proposeKhanDuration` the
// write path uses, so a row listed as unmeasurable is unmeasurable for exactly the reason
// the driver acted on.

import { readdirSync, readFileSync } from 'node:fs';
import { prisma } from '../src/lib/db';
import { proposeKhanDuration, type KhanProbe } from '../src/lib/curation/khan-probe-duration';
import { urlKind } from '../src/lib/curation/serveability';
import { resolveTarget } from './target-guard';

const BATCH_DIR = 'docs/audits';
const BATCH_FILE = /^khan-batch-.+\.jsonl?$/;
const INDEX_CACHE = 'docs/audits/khan-youtube-index.json';

type BatchRow = {
  resourceId: string;
  url: string;
  storedType: 'video' | 'article' | 'interactive';
  probe: (KhanProbe & { title: string; widgets?: number; mainWords: number; hasEditor: boolean }) | null;
  status: 'ok' | 'failed';
  note: string;
};

type DbRow = { id: string; title: string; type: string; url: string; durationMin: number | null };

function arg(name: string, fallback: string) {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

function readBatches(): BatchRow[] {
  const out: BatchRow[] = [];
  for (const f of readdirSync(BATCH_DIR).filter((f) => BATCH_FILE.test(f)).sort()) {
    const raw = readFileSync(`${BATCH_DIR}/${f}`, 'utf8');
    const rows: BatchRow[] = f.endsWith('.jsonl')
      ? raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      : JSON.parse(raw);
    out.push(...rows);
  }
  return out;
}

function section(title: string, evidence: string) {
  console.log(`\n${'─'.repeat(100)}\n${title}\n  EVIDENCE AVAILABLE: ${evidence}\n`);
}

async function main() {
  console.log(`\n=== report-unmeasured (READ-ONLY) ===`);
  console.log(`[report-unmeasured] target: ${resolveTarget().label}`);
  const limit = Number(arg('limit', '12'));

  const batch = readBatches();
  const cache = new Map<string, number>(
    (JSON.parse(readFileSync(INDEX_CACHE, 'utf8')) as { videoId: string; durationSeconds: number }[]).map((v) => [
      v.videoId,
      v.durationSeconds,
    ]),
  );

  // The cached index covers Khan's main channel only, so a talkthrough attached to a coding
  // challenge misses it and would be reported "unresolved" — which would understate what is
  // knowable about group 2. Ask the Data API for the stragglers before classifying anything.
  const missing = [...new Set(batch.flatMap((r) => r.probe?.videoIds ?? []))].filter((id) => !cache.has(id));
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (missing.length && key) {
    for (let i = 0; i < missing.length; i += 50) {
      const u = new URL('https://www.googleapis.com/youtube/v3/videos');
      u.searchParams.set('part', 'contentDetails');
      u.searchParams.set('id', missing.slice(i, i + 50).join(','));
      u.searchParams.set('key', key);
      const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const json = (await res.json()) as { items?: { id?: string; contentDetails?: { duration?: string } }[] };
      for (const v of json.items ?? []) {
        const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(v.contentDetails?.duration ?? '');
        if (v.id && m) cache.set(v.id, Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
      }
    }
    console.log(`[report-unmeasured] resolved ${missing.filter((id) => cache.has(id)).length}/${missing.length} uncached video id(s) via the Data API`);
  }

  // Only rows the library still calls unknown. A row a reviewer has since reached, or that
  // this backfill wrote, is not residue and must not pad the list.
  const stillUnknown = new Map<string, DbRow>(
    (
      await prisma.$queryRaw<DbRow[]>`
        SELECT id, title, type::text AS type, url, "durationMin"
        FROM "Resource"
        WHERE status::text = 'active' AND "durationSource"::text = 'unknown'`
    ).map((r) => [r.id, r]),
  );

  type Item = { db: DbRow; row: BatchRow; why: string };
  const groups = new Map<string, Item[]>();
  const add = (k: string, item: Item) => groups.set(k, [...(groups.get(k) ?? []), item]);

  for (const row of batch) {
    const db = stillUnknown.get(row.resourceId);
    if (!db) continue;
    const p = proposeKhanDuration(row.storedType, row.url, row.status === 'failed' ? null : row.probe, cache);
    if (p.durationMin != null) continue;
    const why = p.evidence;
    if (/needs review/.test(why)) add('kind-flip', { db, row, why });
    else if (/coding challenge/.test(why)) add('challenge', { db, row, why });
    else if (/content floor/.test(why)) add('exercise-article', { db, row, why });
    else if (/unresolved|failure|blocked/.test(why)) add('dead', { db, row, why });
    else add('other', { db, row, why });
  }

  const seen = new Set(batch.map((r) => r.resourceId));
  const nonKhan = [...stillUnknown.values()].filter((r) => !seen.has(r.id) && !/khanacademy\.org/.test(r.url));
  const khanContainer = [...stillUnknown.values()].filter((r) => !seen.has(r.id) && /khanacademy\.org/.test(r.url));

  // ── 1 ────────────────────────────────────────────────────────────────────
  const ex = (groups.get('exercise-article') ?? []).sort(
    (a, b) => (b.row.probe?.widgets ?? 0) - (a.row.probe?.widgets ?? 0),
  );
  section(
    `1. EXERCISE-HEAVY ARTICLES — ${ex.length} rows`,
    `an exact word count AND an exact exercise-widget count for every row. A per-widget\n` +
      `  constant is therefore computable; what is missing is a calibration for it, not data.`,
  );
  console.log(`  ${'words'.padStart(6)} ${'widgets'.padStart(8)}  ${'@1min'.padStart(6)} ${'@2min'.padStart(6)}   title / url`);
  for (const i of ex.slice(0, limit)) {
    const w = i.row.probe?.articleWords ?? 0;
    const g = i.row.probe?.widgets ?? 0;
    const read = Math.max(1, Math.round(w / 120));
    console.log(
      `  ${String(w).padStart(6)} ${String(g).padStart(8)}  ${String(read + g).padStart(6)} ${String(read + g * 2).padStart(6)}   ${i.db.title.slice(0, 58)}\n` +
        `  ${' '.repeat(30)}   ${i.db.url}`,
    );
  }
  if (ex.length > limit) console.log(`  … and ${ex.length - limit} more`);
  const widgetTotals = ex.map((i) => i.row.probe?.widgets ?? 0);
  if (widgetTotals.length) {
    console.log(
      `\n  widget count: min ${Math.min(...widgetTotals)}, max ${Math.max(...widgetTotals)}, ` +
        `median ${widgetTotals.sort((a, b) => a - b)[Math.floor(widgetTotals.length / 2)]}`,
    );
  }

  // ── 2 ────────────────────────────────────────────────────────────────────
  const ch = groups.get('challenge') ?? [];
  section(
    `2. CODING CHALLENGES — ${ch.length} rows`,
    `almost nothing. No prose, no countable exercises: the task lives in editor/canvas state\n` +
      `  the page never renders as text. Some carry a talkthrough video (id below) whose runtime\n` +
      `  is a FLOOR for the row, not its duration — the challenge follows the video.`,
  );
  for (const i of ch.slice(0, limit)) {
    const vid = i.row.probe?.videoIds?.[0];
    const secs = vid ? cache.get(vid) : undefined;
    console.log(
      `  ${(vid ? `video ${vid}${secs ? ` (${Math.round(secs / 60)}min)` : ' (unresolved)'}` : 'no video').padEnd(34)} ${i.db.title.slice(0, 50)}\n` +
        `  ${' '.repeat(34)} ${i.db.url}`,
    );
  }
  if (ch.length > limit) console.log(`  … and ${ch.length - limit} more`);
  console.log(`\n  of these, ${ch.filter((i) => (i.row.probe?.videoIds?.length ?? 0) > 0).length} embed a video and ${ch.filter((i) => !(i.row.probe?.videoIds?.length ?? 0)).length} embed nothing at all`);

  // ── 3 ────────────────────────────────────────────────────────────────────
  const kf = groups.get('kind-flip') ?? [];
  section(
    `3. URL CHANGED CONTENT KIND — ${kf.length} rows`,
    `full: the page was read successfully. These are measurable the moment someone decides\n` +
      `  what the row should POINT at — the block is a data question, not a measurement one.`,
  );
  for (const i of kf.slice(0, limit)) {
    console.log(
      `  /${urlKind(i.row.url) ?? '—'}/ → /${urlKind(i.row.probe?.url ?? '') ?? '—'}/  ${i.db.title.slice(0, 52)}\n` +
        `      stored: ${i.row.url}\n      serves: ${i.row.probe?.url}`,
    );
  }

  // ── 4 ────────────────────────────────────────────────────────────────────
  const dead = groups.get('dead') ?? [];
  section(`4. DEAD OR UNRESOLVABLE — ${dead.length} rows`, `none, and that is the finding: these look like dead resources, not unmeasured ones.`);
  for (const i of dead) console.log(`  ${i.why}\n      ${i.db.title.slice(0, 60)}\n      ${i.db.url}`);

  const other = groups.get('other') ?? [];
  if (other.length) {
    section(`5. UNCLASSIFIED — ${other.length} rows`, `see the reason on each line.`);
    for (const i of other.slice(0, limit)) console.log(`  ${i.why}\n      ${i.db.url}`);
  }

  // ── 6 ────────────────────────────────────────────────────────────────────
  section(
    `6. NEVER BROWSED — ${nonKhan.length} non-Khan rows + ${khanContainer.length} Khan containers`,
    `unknown — these were out of scope for this Khan-only pass. Most non-Khan hosts serve\n` +
      `  their prose in the HTML, so estimateDocsArticle may already cover them without a browser.`,
  );
  const byHost = new Map<string, DbRow[]>();
  for (const r of nonKhan) {
    const h = new URL(r.url).hostname.replace(/^www\./, '');
    byHost.set(h, [...(byHost.get(h) ?? []), r]);
  }
  for (const [h, rows] of [...byHost.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(rows.length).padStart(3)}  ${h.padEnd(28)} e.g. ${rows[0].title.slice(0, 44)}`);
  }

  console.log(
    `\n${'─'.repeat(100)}\n  TOTAL still unknown: ${stillUnknown.size}` +
      `\n  browsed and unmeasurable: ${ex.length + ch.length + kf.length + dead.length + other.length}` +
      `\n  never browsed:            ${nonKhan.length + khanContainer.length}\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
