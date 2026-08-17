// Library-quality B4 (block Q6b) — the one-time re-derivation of the 1,177 rows
// whose `durationMin` is the placeholder 20.
//
//   DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local scripts/rederive-durations.ts
//   … --apply                       # write
//   … --apply --pass=khan,containers
//   … --refresh-index               # re-enumerate the Khan channel (~200 quota units)
//   … --retry-unknown               # re-attempt rows a previous run left unknown
//   … --rederive-unattributed       # EVERY row stamped unknown, whatever number it holds
//   … --max-growth=2                # refuse an overwrite more than 2x the stored number
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
// `--rederive-unattributed` widens it the rest of the way, to EVERY row stamped
// `unknown` whatever number it holds. Measured on production 2026-08-14: of 918
// unattributed active rows, 40 sit at the placeholder and 433 are null, so the two
// narrower scopes together can never see the remaining **445** — including all 85
// ocw.mit.edu rows (45–60m lecture lengths) and 26 Lamar rows (two of them at 900m
// for a single algebra page). Those numbers are not placeholders, which is exactly
// why no selector keyed on the placeholder reaches them.
//
// ⚠️ The widened scope is the only mode that can overwrite a number a human might
// have set. Rows hand-corrected on 2026-08-05 (43 KA Cryptography, 11 OCW 6.0002,
// 7 6.045J) are NO LONGER excluded by construction — the narrow selector missed
// them because a hand-set duration is not 20, and this scope does not. What still
// protects a deliberate human measurement is `durationSource`: Q9 stamps `reviewer`,
// every scope here requires `unknown`, and the schema's rule is that no automated
// pass may overwrite a `reviewer` row. A hand edit made through the bare PATCH route
// before Q9 left no such mark and is indistinguishable from a model's guess.
//
// ── NEVER TRADE A NUMBER FOR A NULL ──────────────────────────────────────────
//
// Under the widened scope a pass meets rows that already hold a plausible number,
// so `write()` will not clear one just because an estimator declined. Nulling a 60m
// OCW lecture sends it to its type's median in the allocator
// (`allocate.ts:effectiveDurationMin`), which is further from the truth than the
// number we already had. A row is overwritten on a MEASUREMENT, never on a shrug.
// The placeholder 20 is the deliberate exception: it is known not to be a
// measurement, which is this driver's founding premise.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { prisma } from '../src/lib/db';
import { checkDuration, containerDuration } from '../src/lib/agents/decomposition/duration-rules';
import {
  estimateDocsArticle,
  estimateLamarArticle,
  estimateOcwPage,
  estimateOcwPdf,
  isoDurationToSeconds,
  ocwArtifact,
  onrampReadingMinutes,
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

// `durationMin` is carried because `write()` needs to know whether declining would
// destroy a number — see "never trade a number for a null" above.
//
// `childCount` and `decompositionStatus` are carried because Q2's plausibility gate
// needs them and this driver was not supplying them: `checkDuration` classifies a
// multi-unit work as `type === 'course' && childCount > 1`, so passing only `{type,
// durationMin}` left `childCount` undefined, no course was ever multi-unit, and the
// 30-minute floor could not fire. The narrow selector hid it — containers sat at the
// placeholder and were settled later by `containerPass` — and the widened scope
// exposed it immediately: a dry run rewrote the `Introduction to Convex Optimization`
// root from 1800 to 3 minutes, having word-counted its landing page.
type Row = {
  id: string;
  url: string;
  title: string;
  type: string;
  durationMin: number | null;
  childCount: number;
  decompositionStatus: string;
};

// Which unattributed rows a pass may touch. Every scope also requires
// `durationSource = 'unknown'`; they differ only in which stored numbers qualify.
type Scope = 'placeholder' | 'with-nulls' | 'unattributed';

const SCOPE_PREDICATE: Record<Scope, string> = {
  placeholder: `"durationMin" = ${PLACEHOLDER}`,
  'with-nulls': `("durationMin" IS NULL OR "durationMin" = ${PLACEHOLDER})`,
  unattributed: 'TRUE',
};

// `leavesOnly` keeps a container out of a pass that measures one artifact. A course
// root's own page is a table of contents, so word-counting it answers a question
// nobody asked: its duration is its children's sum, which is `containerPass`'s job and
// runs after every leaf is settled. Without this the widened scope let a leaf
// estimator overwrite four Lamar course indexes (`CalcIII.aspx` 900 → 27) with the
// reading time of their own link lists.
//
// Deprecated rows are excluded for a plainer reason: they are not in the library any
// more, and fetching them spends someone else's bandwidth to improve a row no learner
// can reach. The original narrow selector had no status predicate either, which is why
// a dry run of the widened scope attempted 111 OCW rows against 85 active ones.
async function selectRows(
  where: string,
  scope: Scope,
  limit?: number,
  { leavesOnly = false }: { leavesOnly?: boolean } = {},
): Promise<Row[]> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT r.id, r.url, r.title, r.type::text AS type, r."durationMin",
            r."decompositionStatus"::text AS "decompositionStatus",
            (SELECT COUNT(*)::int FROM "Resource" c WHERE c."parentResourceId" = r.id) AS "childCount"
     FROM "Resource" r
     WHERE r."durationSource"::text = 'unknown'
       AND r.status::text = 'active'
       AND ${SCOPE_PREDICATE[scope].replace(/"durationMin"/g, 'r."durationMin"')}
       ${leavesOnly ? 'AND NOT EXISTS (SELECT 1 FROM "Resource" c WHERE c."parentResourceId" = r.id)' : ''}
       AND ${where.replace(/(?<!r\.)\burl\b/g, 'r.url').replace(/(?<!r\.)\btype::text\b/g, 'r.type::text')}
     ORDER BY r.id${limit ? ` LIMIT ${limit}` : ''}`,
  );
  return rows;
}

// `--diff` fills this: every row whose number actually moves, so an operator can read
// the overwrite before authorising it rather than after. Under the widened scope the
// old value is often plausible, and a count alone ("recovered 87") cannot distinguish
// a lecture correctly re-measured from one replaced by a worse guess.
const changes: { title: string; url: string; from: number | null; to: number | null; src: string }[] = [];

// `--max-growth=N`: refuse to overwrite an existing number with a derived one more
// than N times larger. A re-measurement that multiplies a plausible stored value is
// more often an artifact mismatch than a correction — measured 2026-08-16, the 17 rows
// that more than doubled were nearly all OCW slide decks costed by
// `OCW_PDF_MIN_PER_PAGE`, whose own comment admits it cannot tell a deck from dense
// notes (Boyd's 24-page `MIT6_079F09_lec02.pdf` → 96 minutes). `api` values are exempt:
// a provider's own number is authoritative however far it moves.
//
// Parsed at module scope so `write()` can consult it without threading a parameter
// through every pass. `run-against-prod.ts` rewrites argv before importing this file,
// so the flag is visible here either way.
const MAX_GROWTH = (() => {
  const arg = process.argv.find((a) => a.startsWith('--max-growth='));
  return arg ? Number(arg.slice('--max-growth='.length)) : Infinity;
})();

// What `write()` concluded about one row. `kept` and `held` both leave the row
// untouched and exist only for the widened scope, but they are different findings and
// are counted separately: `kept` is "the estimator read nothing usable", `held` is "the
// estimator produced a number we do not trust enough to overwrite a plausible one".
type WriteOutcome = 'recovered' | 'unknown' | 'kept' | 'held';

// The single write point, so the Q2 plausibility gate cannot be bypassed by a pass
// that forgot it: a rejected number costs the number, never the row.
//
// `mayClear` opts out of the no-downgrade rule for the one caller whose entire purpose
// is to remove a number — `bookFloorPass` has a VERDICT about the stored value ("under
// the multi-unit floor, so it is a surviving placeholder"), which is a different act
// from an estimator that could not read the page and learned nothing.
async function write(
  row: Row,
  estimate: DurationEstimate,
  apply: boolean,
  { mayClear = false }: { mayClear?: boolean } = {},
): Promise<WriteOutcome> {
  const vetted = checkDuration({
    type: row.type,
    durationMin: estimate.durationMin,
    decompositionStatus: row.decompositionStatus,
    childCount: row.childCount,
  }).ok
    ? estimate
    : UNKNOWN;
  if (
    vetted.durationMin == null &&
    !mayClear &&
    row.durationMin != null &&
    row.durationMin !== PLACEHOLDER
  ) {
    return 'kept';
  }
  if (
    vetted.durationMin != null &&
    vetted.durationSource !== 'api' &&
    row.durationMin != null &&
    row.durationMin !== PLACEHOLDER &&
    vetted.durationMin > row.durationMin * MAX_GROWTH
  ) {
    return 'held';
  }
  // Every write here lands on a row whose source was `unknown`, so a write always
  // changes something even when the number is identical — the chapter and generated
  // passes recover provenance alone. Recording only number moves reported "0 rows
  // change" for a run that re-provenanced 72.
  {
    changes.push({
      title: row.title,
      url: row.url,
      from: row.durationMin,
      to: vetted.durationMin,
      src: vetted.durationSource,
    });
  }
  if (apply) {
    await prisma.resource.update({
      where: { id: row.id },
      data: { durationMin: vetted.durationMin, durationSource: vetted.durationSource },
    });
  }
  return vetted.durationMin == null ? 'unknown' : 'recovered';
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

// ⚠️ "COULD NOT READ THE PAGE" IS NOT "THE PAGE HAS NO DURATION", and this driver
// conflated them once, expensively. On 2026-08-13 an --apply run met a DNS blackhole
// (`tutorial.math.lamar.edu` resolving to 10.68.0.1) and wrote all 156 Lamar rows to
// null/unknown — 153 of which the dry run twenty minutes earlier had recovered. A
// network fault got recorded as 156 statements about the library.
//
// So the result is explicit: `unreachable` rows are SKIPPED, never written. They keep
// their placeholder, stay matched by the resume selector, and cost one re-run — which
// is the whole reason the selector exists. Only a page we actually read may conclude
// `unknown`.
//
// The timeout must also cover the BODY READ. `AbortSignal.timeout` keeps running while
// the body streams, so a slow response rejects out of `res.text()`, outside a `.catch()`
// on the fetch alone — that escaped as an unhandled rejection and killed an --apply run
// 18 rows in, after the Khan pass had already written.
type Fetched = { ok: true; body: string } | { ok: false };

async function fetchText(url: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': FETCH_UA, accept: 'text/html' },
      signal: AbortSignal.timeout(30_000),
    });
    // A non-2xx is not a durable fact about the resource either: 403/429/503 are the
    // shapes a rate-limited crawler sees, and treating them as "no duration" would bake
    // a throttle into the library.
    return res.ok ? { ok: true, body: await res.text() } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// A site that fails wholesale is an environment fault, not a property of the rows. Half
// a pass failing means the next passes would run on evidence nobody gathered — the
// container pass in particular sums children that were never re-derived — so stop and
// let the operator fix the network. Nothing has been written for the skipped rows, so
// aborting costs only the run.
const UNREACHABLE_ABORT_RATIO = 0.5;
const UNREACHABLE_ABORT_FLOOR = 10;

function assertSiteReachable(pass: string, attempted: number, unreachable: number) {
  if (attempted < UNREACHABLE_ABORT_FLOOR) return;
  if (unreachable / attempted < UNREACHABLE_ABORT_RATIO) return;
  throw new Error(
    `[${pass}] ${unreachable}/${attempted} fetches failed — that is a network or blocking ` +
      `problem, not ${unreachable} rows without durations. Nothing was written for them. ` +
      `Fix connectivity and re-run; the resume selector still matches every skipped row.`,
  );
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

async function khanPass(apply: boolean, refresh: boolean, scope: Scope, limit?: number) {
  const videoRows = await selectRows(`url ~ 'khanacademy\\.org' AND type::text = 'video'`, scope, limit, {
    leavesOnly: true,
  });
  const unreachable = await selectRows(
    `url ~ 'khanacademy\\.org' AND type::text IN ('article', 'interactive')`,
    scope,
    limit,
    { leavesOnly: true },
  );
  console.log(`\n[khan] ${videoRows.length} video row(s), ${unreachable.length} article/interactive row(s)`);
  if (videoRows.length === 0 && unreachable.length === 0) return { quotaUnits: 0 };

  const { videos, quotaUnits } = await khanIndex(refresh);
  const index = buildIndex(videos);

  const tally = { matched: 0, noMatch: 0, ambiguous: 0 };
  const outcomes: WriteOutcome[] = [];
  for (const row of videoRows) {
    const hit = lookupTitle(index, row.title);
    if (hit.ok) {
      tally.matched += 1;
      outcomes.push(
        await write(row, { durationMin: secondsToMinutes(hit.video.durationSeconds), durationSource: 'api' }, apply),
      );
    } else {
      tally[hit.reason === 'no-match' ? 'noMatch' : 'ambiguous'] += 1;
      outcomes.push(await write(row, UNKNOWN, apply));
    }
  }
  // No route reaches these. Not "we tried and failed" — they are not on YouTube and
  // their page text is behind the wall, so the placeholder is removed and nothing
  // replaces it. Q9's reviewers are the next step for them. Under the widened scope
  // the ones already holding a non-placeholder number keep it: unreadable is not the
  // same finding as "the stored number is wrong".
  for (const row of unreachable) outcomes.push(await write(row, UNKNOWN, apply));

  const kept = outcomes.filter((o) => o === 'kept' || o === 'held').length;
  console.log(
    `  matched ${tally.matched}, no-match ${tally.noMatch}, ambiguous ${tally.ambiguous}` +
      `  |  swept to unknown: ${outcomes.filter((o) => o === 'unknown').length}` +
      (kept ? `  |  kept an existing number: ${kept}` : ''),
  );
  return { quotaUnits };
}

// ── Lamar: static HTML, reading time from word count ─────────────────────────

async function lamarPass(apply: boolean, scope: Scope, limit?: number) {
  const rows = await selectRows(`url ~ 'tutorial\\.math\\.lamar\\.edu'`, scope, limit, { leavesOnly: true });
  console.log(`\n[lamar] ${rows.length} row(s)`);
  const results = await mapPool(rows, async (row) => {
    const page = await fetchText(row.url);
    if (!page.ok) return null;
    return write(row, estimateLamarArticle(page.body), apply);
  });
  summarise('lamar', results);
}

// ── static documentation and tutorial hosts ──────────────────────────────────

// The group-1 hosts: plain server-rendered HTML whose prose is in the bytes, so a word
// count is a measurement rather than a guess. An allowlist and not a catch-all — the
// estimator assumes the fetched document IS the content, which is false for a SPA
// shell, a paywall, or a bot wall, and each of those would quietly produce a number.
const DOCS_HOSTS = [
  'react\\.dev',
  'docs\\.python\\.org',
  'freecodecamp\\.org',
  'pandas\\.pydata\\.org',
  'scikit-learn\\.org',
  'developer\\.mozilla\\.org',
  'openstax\\.org',
  'openlearninglibrary\\.mit\\.edu',
];

async function docsPass(apply: boolean, scope: Scope, limit?: number) {
  const rows = await selectRows(`url ~ '(${DOCS_HOSTS.join('|')})'`, scope, limit, { leavesOnly: true });
  console.log(`\n[docs] ${rows.length} row(s)`);
  const results = await mapPool(rows, async (row) => {
    const page = await fetchText(row.url);
    if (!page.ok) return null;
    return write(row, estimateDocsArticle(page.body), apply);
  });
  summarise('docs', results);
}

// ── OCW: the artifact the resource page wraps ────────────────────────────────

async function ocwPass(apply: boolean, scope: Scope, limit?: number) {
  const rows = await selectRows(`url ~ 'ocw\\.mit\\.edu'`, scope, limit, { leavesOnly: true });
  console.log(`\n[ocw] ${rows.length} row(s)`);

  // Video pages are resolved through the same Data API as Khan's, in one batch, so
  // a lecture video costs an exact duration rather than a page-count guess.
  // `null` means unreachable — skipped, exactly as in the Lamar pass. Both the resource
  // page and the PDF it wraps are fetches that can fail for reasons that say nothing
  // about the resource.
  const pending: ({ row: Row; videoId?: string; estimate?: DurationEstimate } | null)[] = await mapPool(
    rows,
    async (row) => {
      const page = await fetchText(row.url);
      if (!page.ok) return null;
      const artifact = ocwArtifact(page.body);
      if (artifact?.kind === 'youtube') return { row, videoId: artifact.videoId };
      if (artifact?.kind === 'pdf') {
        const href = artifact.href.startsWith('http') ? artifact.href : `https://ocw.mit.edu${artifact.href}`;
        const res = await fetch(href, {
          headers: { 'user-agent': FETCH_UA },
          signal: AbortSignal.timeout(60_000),
        }).catch(() => null);
        if (!res?.ok) return null;
        const bytes = await res.arrayBuffer().catch(() => null);
        if (!bytes) return null;
        return { row, estimate: estimateOcwPdf(new Uint8Array(bytes)) };
      }
      return { row, estimate: estimateOcwPage(page.body) };
    },
  );
  const reached = pending.filter((p) => p !== null);
  // Checked here as well as in `summarise` below: this is ahead of the YouTube batch, so a
  // dead ocw.mit.edu aborts before spending quota on ids gathered from the few pages that
  // did load.
  assertSiteReachable('ocw', pending.length, pending.length - reached.length);

  const videoIds = reached.filter((p) => p.videoId).map((p) => p.videoId ?? '');
  const durations = await youtubeDurations(videoIds);
  const results: (WriteOutcome | null)[] = new Array(pending.length - reached.length).fill(null);
  for (const p of reached) {
    const seconds = p.videoId ? durations.get(p.videoId) : undefined;
    const estimate: DurationEstimate = seconds
      ? { durationMin: secondsToMinutes(seconds), durationSource: 'api' }
      : (p.estimate ?? UNKNOWN);
    results.push(await write(p.row, estimate, apply));
  }
  summarise('ocw', results);
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

// ── youtube chapters: a provenance, not a measurement ────────────────────────

// 45 active rows are timestamped chapters of two long videos (`?v=…&t=10433s`), each a
// decomposed child carrying its own span. `resolve-unknowns`'s attribute pass declined
// all 45 because it compared a 9-minute chapter against the 365-minute parent the Data
// API knows about — correctly, since the API cannot describe a chapter.
//
// So nothing here is re-measured. The numbers are already right, and the evidence is
// arithmetic: the 21 chapters of the linear-algebra video sum to 354 minutes against an
// api-measured parent of 365, and the 24 SQL chapters sum to 261 against a parent of
// 240. What they lack is a provenance, and `extracted` is the enum's own word for it —
// a chapter list is the artifact stating its own divisions.
async function chapterPass(apply: boolean) {
  const rows = await selectRows(
    `url ~ '(youtube\\.com|youtu\\.be)' AND url ~ '[?&]t=' AND r."parentResourceId" IS NOT NULL
       AND r."durationMin" IS NOT NULL AND r."durationMin" > 0`,
    'unattributed',
  );
  console.log(`\n[chapters] ${rows.length} timestamped chapter row(s) carrying a span with no provenance`);
  const outcomes: WriteOutcome[] = [];
  for (const row of rows) {
    outcomes.push(await write(row, { durationMin: row.durationMin ?? 0, durationSource: 'extracted' }, apply));
  }
  console.log(`  stamped extracted (number unchanged): ${outcomes.filter((o) => o === 'recovered').length}`);
}

// ── generated://  — the one duration that is arithmetic ──────────────────────

// Our own authored on-ramp lessons, whose text is in `Resource.content`. No fetch, no
// estimate about someone else's page: the same function the generator uses on the way
// in, applied to rows written before that path stamped a provenance.
async function generatedPass(apply: boolean) {
  const rows = await prisma.$queryRaw<(Row & { content: string | null })[]>`
    SELECT r.id, r.url, r.title, r.type::text AS type, r."durationMin", r.content,
           r."decompositionStatus"::text AS "decompositionStatus",
           (SELECT COUNT(*)::int FROM "Resource" c WHERE c."parentResourceId" = r.id) AS "childCount"
    FROM "Resource" r
    WHERE r.status::text = 'active' AND r."durationSource"::text = 'unknown'
      AND r.url ~ '^generated://'
    ORDER BY r.id`;
  console.log(`\n[generated] ${rows.length} authored row(s)`);
  const outcomes: WriteOutcome[] = [];
  for (const row of rows) {
    if (!row.content?.trim()) {
      outcomes.push(await write(row, UNKNOWN, apply));
      continue;
    }
    outcomes.push(
      await write(row, { durationMin: onrampReadingMinutes(row.content), durationSource: 'extracted' }, apply),
    );
  }
  summarise('generated', outcomes);
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
    SELECT r.id, r.url, r.title, r.type::text AS type, r."durationMin",
           r."decompositionStatus"::text AS "decompositionStatus",
           (SELECT COUNT(*)::int FROM "Resource" c WHERE c."parentResourceId" = r.id) AS "childCount"
    FROM "Resource" r
    WHERE r.type::text = 'book' AND r."durationMin" IS NOT NULL AND r."durationMin" < 30
      AND r."durationSource"::text <> 'reviewer'`;
  console.log(`\n[books] ${rows.length} book(s) under the 30-minute floor`);
  // `mayClear`: this pass is the one place a null IS the finding, so it opts out of
  // the no-downgrade rule that protects every other caller.
  for (const row of rows) await write(row, UNKNOWN, apply, { mayClear: true });
}

// ── reporting ────────────────────────────────────────────────────────────────

// `null` is a row the pass could not read and therefore did not write. It is reported
// separately from `unknown` because the two mean opposite things: `unknown` is a
// conclusion about the resource, `unreachable` is an admission about the run.
function summarise(pass: string, results: (WriteOutcome | null)[]) {
  const reached = results.filter((r) => r !== null);
  const unreachable = results.length - reached.length;
  const count = (o: WriteOutcome) => reached.filter((r) => r === o).length;
  // `kept` is reported separately from both: it is neither a recovery nor a statement
  // that the row has no duration, but a decision to leave an unattributed number alone.
  const line =
    `  recovered ${count('recovered')}, unknown ${count('unknown')}` +
    (count('kept') ? `, kept an existing number ${count('kept')}` : '') +
    (count('held') ? `, held (over --max-growth) ${count('held')}` : '');
  console.log(unreachable ? `${line}, unreachable ${unreachable} (skipped, not written)` : line);
  assertSiteReachable(pass, results.length, unreachable);
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
  const scope: Scope = process.argv.includes('--rederive-unattributed')
    ? 'unattributed'
    : process.argv.includes('--retry-unknown')
      ? 'with-nulls'
      : 'placeholder';
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
  const passArg = process.argv.find((a) => a.startsWith('--pass='));
  const passes = new Set((passArg?.slice('--pass='.length) ?? 'khan,lamar,ocw,docs,chapters,generated,containers,books').split(','));

  console.log(`\n=== rederive-durations (${apply ? 'APPLY' : 'DRY RUN'}) — scope: ${scope} ===`);
  requireTargetAck('rederive-durations', apply, 'REWRITE durations');
  await report('BEFORE');

  let quota = 0;
  if (passes.has('khan')) quota += (await khanPass(apply, refresh, scope, limit)).quotaUnits;
  if (passes.has('lamar')) await lamarPass(apply, scope, limit);
  if (passes.has('ocw')) await ocwPass(apply, scope, limit);
  if (passes.has('docs')) await docsPass(apply, scope, limit);
  if (passes.has('chapters')) await chapterPass(apply);
  if (passes.has('generated')) await generatedPass(apply);
  if (passes.has('containers')) await containerPass(apply);
  if (passes.has('books')) await bookFloorPass(apply);

  await report('AFTER');

  if (process.argv.includes('--diff')) {
    // Sorted by how far the number moves: a re-measurement that barely shifts the value
    // needs no scrutiny, and the ones that rewrite a plausible number into a very
    // different one are the whole reason to look.
    const moved = changes.filter((c) => c.from != null && c.to !== c.from);
    moved.sort((a, b) => Math.abs((b.to ?? 0) - (b.from ?? 0)) - Math.abs((a.to ?? 0) - (a.from ?? 0)));
    const filled = changes.filter((c) => c.from == null && c.to != null).length;
    const stampedOnly = changes.filter((c) => c.to === c.from).length;
    const cleared = changes.filter((c) => c.from != null && c.to == null).length;
    console.log(
      `\n=== ${changes.length} row(s) change: ${moved.length} overwrite a number, ` +
        `${filled} fill a null, ${stampedOnly} keep the number and gain a provenance, ${cleared} cleared`,
    );
    for (const c of moved) {
      console.log(
        `  ${String(c.from).padStart(5)} → ${String(c.to).padStart(5)}  ${c.src.padEnd(9)} ` +
          `${c.title.slice(0, 52).padEnd(52)} ${c.url.slice(0, 60)}`,
      );
    }
  }

  console.log(`\nYouTube quota spent this run: ${quota} unit(s)`);
  if (!apply) console.log('Dry run only — nothing was written. Re-run with --apply.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
