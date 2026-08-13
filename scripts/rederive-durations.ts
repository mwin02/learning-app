// Library-quality B4 (block Q6b) — the one-time re-derivation of the 1,177 rows
// whose `durationMin` is the placeholder 20.
//
//   DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local scripts/rederive-durations.ts
//   … --apply                       # write
//   … --apply --pass=khan,containers
//   … --refresh-index               # re-enumerate the Khan channel (~200 quota units)
//   … --retry-unknown               # re-attempt rows a previous run left unknown
//
// ⚠️ NO PASS HERE FETCHES `khanacademy.org` OR `kastatic.org`. Q6a found their
// `/robots.txt` itself behind a bot wall, so there is no policy we can read and no
// permission we can claim; Khan durations come from Khan's own YouTube channel
// through the official Data API instead (`sources/khan/youtube-index.ts`). Khan's
// articles and interactives are on YouTube in no form at all, so they are swept to
// `unknown` and wait for a reviewer (Q9). That is the designed outcome of this
// block, not a shortfall — see B4.
//
// ── THE RESUME SELECTOR ──────────────────────────────────────────────────────
//
// `durationSource = 'unknown' AND durationMin = 20` — the placeholder's exact
// signature, and it is what makes a second run cheap and a third one free.
// Recovering a row stamps a real source, so it stops matching. A row that resists
// recovery is written null + `unknown`, so it ALSO stops matching — which is the
// Q3 lesson applied: a row the estimator has already declined will decline again,
// and retrying it forever bills the network for a known answer. `--retry-unknown`
// widens the selector to null rows for the case that actually justifies a retry:
// the estimator got better.
//
// Rows hand-corrected on 2026-08-05 (43 KA Cryptography, 11 OCW 6.0002, 7 6.045J)
// are excluded by construction rather than by a list — a hand-set duration is not
// 20, so the selector never sees it.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { prisma } from '../src/lib/db';
import { checkDuration, containerDuration } from '../src/lib/agents/decomposition/duration-rules';
import {
  estimateLamarArticle,
  estimateOcwPage,
  estimateOcwPdf,
  isoDurationToSeconds,
  ocwArtifact,
  secondsToMinutes,
  UNKNOWN,
  type DurationEstimate,
} from '../src/lib/curation/duration-estimate';
import {
  buildIndex,
  fetchKhanUploads,
  lookupTitle,
  type KhanVideo,
} from '../src/lib/sources/khan/youtube-index';
import { requireTargetAck } from './target-guard';

const INDEX_CACHE = 'docs/audits/khan-youtube-index.json';
const PLACEHOLDER = 20;
const FETCH_CONCURRENCY = 6;
// Same contact UA the pipeline crawls with (doctoc.ts) — a site owner reading their
// logs should see one identity for this app, not one per script.
const FETCH_UA =
  'Mozilla/5.0 (compatible; LearningPathBot/1.0; +https://learning-app-sau6bxtxta-uw.a.run.app)';

type Row = { id: string; url: string; title: string; type: string };

async function selectRows(where: string, retryUnknown: boolean, limit?: number): Promise<Row[]> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT id, url, title, type::text AS type FROM "Resource"
     WHERE "durationSource"::text = 'unknown'
       AND (${retryUnknown ? '"durationMin" IS NULL OR ' : ''}"durationMin" = ${PLACEHOLDER})
       AND ${where}
     ORDER BY id${limit ? ` LIMIT ${limit}` : ''}`,
  );
  return rows;
}

// The single write point, so the Q2 plausibility gate cannot be bypassed by a pass
// that forgot it: a rejected number costs the number, never the row.
async function write(row: Row, estimate: DurationEstimate, apply: boolean): Promise<DurationEstimate> {
  const vetted = checkDuration({ type: row.type, durationMin: estimate.durationMin }).ok
    ? estimate
    : UNKNOWN;
  if (apply) {
    await prisma.resource.update({
      where: { id: row.id },
      data: { durationMin: vetted.durationMin, durationSource: vetted.durationSource },
    });
  }
  return vetted;
}

async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += FETCH_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + FETCH_CONCURRENCY).map(fn))));
    process.stdout.write(`\r    fetched ${Math.min(i + FETCH_CONCURRENCY, items.length)}/${items.length}`);
  }
  if (items.length) process.stdout.write('\n');
  return out;
}

async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { 'user-agent': FETCH_UA, accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  return res?.ok ? res.text() : null;
}

// ── Khan: the YouTube channel index ──────────────────────────────────────────

async function khanIndex(refresh: boolean): Promise<{ videos: KhanVideo[]; quotaUnits: number }> {
  if (!refresh && existsSync(INDEX_CACHE)) {
    const videos = JSON.parse(readFileSync(INDEX_CACHE, 'utf8')) as KhanVideo[];
    console.log(`  index: ${videos.length} videos from cache (0 quota units)`);
    return { videos, quotaUnits: 0 };
  }
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw new Error('YOUTUBE_API_KEY is not set — cannot build the Khan index');
  const { videos, quotaUnits } = await fetchKhanUploads({
    apiKey: key,
    onProgress: (n, total) => process.stdout.write(`\r    enumerating ${n}/${total}`),
  });
  mkdirSync('docs/audits', { recursive: true });
  writeFileSync(INDEX_CACHE, JSON.stringify(videos));
  console.log(`\n  index: ${videos.length} videos, ${quotaUnits} quota units, cached to ${INDEX_CACHE}`);
  return { videos, quotaUnits };
}

async function khanPass(apply: boolean, refresh: boolean, retryUnknown: boolean, limit?: number) {
  const videoRows = await selectRows(`url ~ 'khanacademy\\.org' AND type::text = 'video'`, retryUnknown, limit);
  const unreachable = await selectRows(
    `url ~ 'khanacademy\\.org' AND type::text IN ('article', 'interactive')`,
    retryUnknown,
    limit,
  );
  console.log(`\n[khan] ${videoRows.length} video row(s), ${unreachable.length} article/interactive row(s)`);
  if (videoRows.length === 0 && unreachable.length === 0) return { quotaUnits: 0 };

  const { videos, quotaUnits } = await khanIndex(refresh);
  const index = buildIndex(videos);

  const tally = { matched: 0, noMatch: 0, ambiguous: 0 };
  for (const row of videoRows) {
    const hit = lookupTitle(index, row.title);
    if (hit.ok) {
      tally.matched += 1;
      await write(row, { durationMin: secondsToMinutes(hit.video.durationSeconds), durationSource: 'api' }, apply);
    } else {
      tally[hit.reason === 'no-match' ? 'noMatch' : 'ambiguous'] += 1;
      await write(row, UNKNOWN, apply);
    }
  }
  // No route reaches these. Not "we tried and failed" — they are not on YouTube and
  // their page text is behind the wall, so the placeholder is removed and nothing
  // replaces it. Q9's reviewers are the next step for them.
  for (const row of unreachable) await write(row, UNKNOWN, apply);

  console.log(
    `  matched ${tally.matched}, no-match ${tally.noMatch}, ambiguous ${tally.ambiguous}` +
      `  |  swept to unknown: ${tally.noMatch + tally.ambiguous + unreachable.length}`,
  );
  return { quotaUnits };
}

// ── Lamar: static HTML, reading time from word count ─────────────────────────

async function lamarPass(apply: boolean, retryUnknown: boolean, limit?: number) {
  const rows = await selectRows(`url ~ 'tutorial\\.math\\.lamar\\.edu'`, retryUnknown, limit);
  console.log(`\n[lamar] ${rows.length} row(s)`);
  const results = await mapPool(rows, async (row) => {
    const html = await fetchText(row.url);
    return write(row, html ? estimateLamarArticle(html) : UNKNOWN, apply);
  });
  summarise(results);
}

// ── OCW: the artifact the resource page wraps ────────────────────────────────

async function ocwPass(apply: boolean, retryUnknown: boolean, limit?: number) {
  const rows = await selectRows(`url ~ 'ocw\\.mit\\.edu'`, retryUnknown, limit);
  console.log(`\n[ocw] ${rows.length} row(s)`);

  // Video pages are resolved through the same Data API as Khan's, in one batch, so
  // a lecture video costs an exact duration rather than a page-count guess.
  const pending: { row: Row; videoId?: string; estimate?: DurationEstimate }[] = await mapPool(
    rows,
    async (row) => {
      const html = await fetchText(row.url);
      if (!html) return { row, estimate: UNKNOWN };
      const artifact = ocwArtifact(html);
      if (artifact?.kind === 'youtube') return { row, videoId: artifact.videoId };
      if (artifact?.kind === 'pdf') {
        const href = artifact.href.startsWith('http') ? artifact.href : `https://ocw.mit.edu${artifact.href}`;
        const res = await fetch(href, { headers: { 'user-agent': FETCH_UA }, signal: AbortSignal.timeout(60_000) }).catch(
          () => null,
        );
        if (!res?.ok) return { row, estimate: UNKNOWN };
        return { row, estimate: estimateOcwPdf(new Uint8Array(await res.arrayBuffer())) };
      }
      return { row, estimate: estimateOcwPage(html) };
    },
  );

  const videoIds = pending.filter((p) => p.videoId).map((p) => p.videoId ?? '');
  const durations = await youtubeDurations(videoIds);
  const results: DurationEstimate[] = [];
  for (const p of pending) {
    const seconds = p.videoId ? durations.get(p.videoId) : undefined;
    const estimate: DurationEstimate = seconds
      ? { durationMin: secondsToMinutes(seconds), durationSource: 'api' }
      : (p.estimate ?? UNKNOWN);
    results.push(await write(p.row, estimate, apply));
  }
  summarise(results);
  if (videoIds.length) console.log(`  (${Math.ceil(videoIds.length / 50)} quota unit(s) for OCW video durations)`);
}

// Batched 50 ids per call, 1 quota unit each. An unreadable response yields an empty
// map, which degrades every affected row to its page estimate or to `unknown`.
async function youtubeDurations(videoIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key || videoIds.length === 0) return out;
  for (let i = 0; i < videoIds.length; i += 50) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('id', videoIds.slice(i, i + 50).join(','));
    url.searchParams.set('key', key);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) continue;
    const json = (await res.json()) as { items?: { id?: string; contentDetails?: { duration?: string } }[] };
    for (const v of json.items ?? []) {
      const seconds = v.contentDetails?.duration ? isoDurationToSeconds(v.contentDetails.duration) : null;
      if (v.id && seconds != null) out.set(v.id, seconds);
    }
  }
  return out;
}

// ── containers, and the multi-unit floor ─────────────────────────────────────

// Runs LAST, and must: a container's duration is its children's sum, so summing
// before the leaves are re-derived would just re-derive the same contradiction from
// the same placeholders.
//
// It also has to run to a FIXED POINT, because containers nest. Recomputing
// `Describing the UI` from its own children took it from 20 to 345, which put its
// parent `React Quick Start` (180) under half of a sum that had been fine one
// statement earlier — a contradiction this pass created itself. One sweep per level
// of nesting settles it; the cap only stops a cycle, which the parent pointer should
// make impossible anyway.
async function containerPass(apply: boolean) {
  for (let round = 1; round <= 8; round += 1) {
    const changed = await containerRound(apply, round);
    // In dry run nothing is written, so round 2 would report the same rows forever.
    if (changed === 0 || !apply) return;
  }
}

// The two passes below select on the number, not on the resume selector, so they are the
// only writes here that `write()`'s `durationSource = 'unknown'` predicate does not already
// protect. They exclude `reviewer` by hand: it is the schema's highest authority ("no
// automated pass may overwrite a `reviewer` row"), and it postdates this driver by three
// blocks. `api`/`extracted` stay in scope deliberately — a container whose stated number
// contradicts its own children is exactly the contradiction this pass exists to settle,
// and the human measurement is the only one we cannot re-derive.
async function containerRound(apply: boolean, round: number): Promise<number> {
  const parents = await prisma.$queryRaw<{ id: string; type: string; durationMin: number | null }[]>`
    SELECT p.id, p.type::text AS type, p."durationMin"
    FROM "Resource" p JOIN "Resource" c ON c."parentResourceId" = p.id
    WHERE p."durationSource"::text <> 'reviewer'
    GROUP BY p.id
    HAVING p."durationMin" IS NULL
        OR p."durationMin" = ${PLACEHOLDER}
        OR p."durationMin" < COALESCE(SUM(c."durationMin"), 0) / 2.0`;
  console.log(`\n[containers round ${round}] ${parents.length} container(s) at odds with their children`);
  let changed = 0;
  for (const parent of parents) {
    const children = await prisma.resource.findMany({
      where: { parentResourceId: parent.id },
      select: { durationMin: true },
    });
    const derived = containerDuration(children);
    if (derived.durationMin === parent.durationMin) continue;
    changed += 1;
    if (apply) {
      await prisma.resource.update({
        where: { id: parent.id },
        data: { durationMin: derived.durationMin, durationSource: derived.durationSource },
      });
    }
  }
  console.log(`  recomputed ${changed}`);
  return changed;
}

// A book or multi-unit course still under the 30-minute floor after every pass is a
// surviving placeholder by Q2's own rule. We have no measurement for it, so it says
// so rather than keeping a number the gate would have rejected on the write path.
async function bookFloorPass(apply: boolean) {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, url, title, type::text AS type FROM "Resource"
    WHERE type::text = 'book' AND "durationMin" IS NOT NULL AND "durationMin" < 30
      AND "durationSource"::text <> 'reviewer'`;
  console.log(`\n[books] ${rows.length} book(s) under the 30-minute floor`);
  for (const row of rows) await write(row, UNKNOWN, apply);
}

// ── reporting ────────────────────────────────────────────────────────────────

function summarise(results: DurationEstimate[]) {
  const known = results.filter((r) => r.durationMin != null);
  console.log(`  recovered ${known.length}, unknown ${results.length - known.length}`);
}

async function report(label: string) {
  const [totals] = await prisma.$queryRaw<{ total: number; at20: number; unknown: number }[]>`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE "durationMin" = 20)::int AS at20,
           COUNT(*) FILTER (WHERE "durationMin" IS NULL)::int AS unknown
    FROM "Resource"`;
  const share = ((totals.at20 / totals.total) * 100).toFixed(1);
  console.log(`\n=== ${label}: ${totals.total} rows | at 20m: ${totals.at20} (${share}%) | null: ${totals.unknown}`);
  const bySource = await prisma.$queryRaw<{ src: string; n: number }[]>`
    SELECT "durationSource"::text AS src, COUNT(*)::int AS n FROM "Resource" GROUP BY 1 ORDER BY 2 DESC`;
  console.log('  by source:', Object.fromEntries(bySource.map((r) => [r.src, r.n])));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const refresh = process.argv.includes('--refresh-index');
  const retryUnknown = process.argv.includes('--retry-unknown');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
  const passArg = process.argv.find((a) => a.startsWith('--pass='));
  const passes = new Set((passArg?.slice('--pass='.length) ?? 'khan,lamar,ocw,containers,books').split(','));

  console.log(`\n=== rederive-durations (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  requireTargetAck('rederive-durations', apply, 'REWRITE durations');
  await report('BEFORE');

  let quota = 0;
  if (passes.has('khan')) quota += (await khanPass(apply, refresh, retryUnknown, limit)).quotaUnits;
  if (passes.has('lamar')) await lamarPass(apply, retryUnknown, limit);
  if (passes.has('ocw')) await ocwPass(apply, retryUnknown, limit);
  if (passes.has('containers')) await containerPass(apply);
  if (passes.has('books')) await bookFloorPass(apply);

  await report('AFTER');
  console.log(`\nYouTube quota spent this run: ${quota} unit(s)`);
  if (!apply) console.log('Dry run only — nothing was written. Re-run with --apply.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
