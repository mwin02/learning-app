// Library-quality Q10 — the standing unknowns nothing else owns.
//
//   DATABASE_URL=… npx tsx --env-file=.env.local scripts/resolve-unknowns.ts
//   … --apply                       # write
//   … --pass=khan-slug,attribute
//   … --retry-declined              # re-attempt rows a previous run could not attribute
//
// Two passes, and BOTH are allowed to end in `unknown`. That is the plan's standing
// rule since B4: the unknown count is reported, not minimised, and a run that drove
// it toward zero by guessing has failed.
//
// ⚠️ NOTHING HERE FETCHES `khanacademy.org` OR `kastatic.org` (Q6a — that host
// answers automated clients with a bot wall, `robots.txt` included). Khan durations
// come from the cached YouTube channel index written by `rederive-durations.ts`;
// this script never enumerates the channel and never calls `search.list`.
//
// ── PASS 1: the Khan video rows the title key missed ─────────────────────────
//
// The stored slug keys the same cached index and resolves most of them, but Q6b
// measured it ~4% confidently wrong, so it may not write unattended. `slug-match.ts`
// classifies: `agreed` (the title key names the same video — safe, silent) is
// written here; `confirm` (the slug alone) is written to a proposals file for the
// /playground/duration-confirm surface, where a reviewer's click stamps
// `durationSource: 'reviewer'` through Q9's existing PATCH seam; `unresolved` stays
// unknown.
//
// ── PASS 2: the numbers stamped `unknown` ────────────────────────────────────
//
// Attribution by RE-DERIVATION only (`attributeByRederivation`). There is no audit
// trail to read — `Resource` has no per-field history and the `ResourceReport`
// trail reaches zero of this population — so the sole honest attribution is "the
// source still reports exactly this number". Everything else stays `unknown` and
// is counted. Nothing here infers provenance from a value's shape.
//
// ── THE RESUME SELECTOR ──────────────────────────────────────────────────────
//
// Pass 1: `status=active AND durationMin IS NULL AND durationSource='unknown'` on
// Khan video rows. A recovered or confirmed row gains a real source and drops out.
// An unresolved one stays selected, which costs a lookup in a file already on disk
// — zero network, zero quota — so a second run is free rather than re-billed.
//
// Pass 2: the same shape inverted (`durationMin IS NOT NULL`), minus a DECLINED
// LEDGER. This pass does spend YouTube quota, and a row it could not attribute will
// not become attributable by asking again, so its id is recorded and skipped on
// every later run. `--retry-declined` clears that — the case that justifies a
// retry is our evidence improving, not the row changing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/db';
import {
  attributeByRederivation,
  isoDurationToSeconds,
  secondsToMinutes,
} from '../src/lib/curation/duration-estimate';
import { buildIndex, type KhanVideo } from '../src/lib/sources/khan/youtube-index';
import { proposeBySlug } from '../src/lib/sources/khan/slug-match';
import { requireTargetAck } from './target-guard';

const INDEX_CACHE = 'docs/audits/khan-youtube-index.json';
const PROPOSALS = 'docs/audits/khan-slug-proposals.json';
const DECLINED = 'docs/audits/duration-attribution-declined.json';

type Row = { id: string; url: string; title: string; durationMin: number | null };

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

function writeJson(path: string, value: unknown) {
  mkdirSync('docs/audits', { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

// ── pass 1 ───────────────────────────────────────────────────────────────────

async function khanSlugPass(apply: boolean) {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, url, title, "durationMin" FROM "Resource"
    WHERE status::text = 'active'
      AND "durationSource"::text = 'unknown'
      AND "durationMin" IS NULL
      AND type::text = 'video'
      AND url ~ 'khanacademy\.org'
    ORDER BY id`;
  console.log(`\n[khan-slug] ${rows.length} Khan video row(s) with no duration`);
  if (rows.length === 0) return;

  const videos = readJson<KhanVideo[] | null>(INDEX_CACHE, null);
  if (!videos) throw new Error(`${INDEX_CACHE} is missing — run rederive-durations.ts first`);
  const index = buildIndex(videos);
  console.log(`  index: ${videos.length} videos from cache (0 quota units, no Khan host contacted)`);

  const tally = { agreed: 0, confirm: 0, unresolved: 0 };
  const proposals: {
    resourceId: string;
    title: string;
    url: string;
    slugKey: string;
    videoId: string;
    videoTitle: string;
    proposedMin: number;
  }[] = [];

  for (const row of rows) {
    const proposal = proposeBySlug(index, row);
    if (proposal.kind === 'unresolved') {
      tally.unresolved += 1;
      continue;
    }
    const proposedMin = secondsToMinutes(proposal.video.durationSeconds);
    if (proposal.kind === 'agreed') {
      tally.agreed += 1;
      if (apply) {
        await prisma.resource.update({
          where: { id: row.id },
          data: { durationMin: proposedMin, durationSource: 'api' },
        });
      }
      continue;
    }
    tally.confirm += 1;
    proposals.push({
      resourceId: row.id,
      title: row.title,
      url: row.url,
      slugKey: proposal.slugKey,
      videoId: proposal.video.videoId,
      videoTitle: proposal.video.title,
      proposedMin,
    });
  }

  writeJson(PROPOSALS, proposals);
  console.log(
    `  recovered silently (both keys agreed): ${tally.agreed}\n` +
      `  awaiting reviewer confirmation (slug key alone): ${tally.confirm} → ${PROPOSALS}\n` +
      `  still unknown (no unique slug match): ${tally.unresolved}`,
  );
}

// ── pass 2 ───────────────────────────────────────────────────────────────────

function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host !== 'youtube.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] ?? null;
    return null;
  } catch {
    return null;
  }
}

// 1 quota unit per 50 ids. A batch that fails to read yields no entries, which
// leaves every row in it unattributed rather than wrongly attributed.
async function youtubeDurations(videoIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw new Error('YOUTUBE_API_KEY is not set — cannot re-derive YouTube durations');
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

async function attributePass(apply: boolean, retryDeclined: boolean) {
  const declined = new Set(retryDeclined ? [] : readJson<string[]>(DECLINED, []));
  const all = await prisma.$queryRaw<Row[]>`
    SELECT id, url, title, "durationMin" FROM "Resource"
    WHERE status::text = 'active'
      AND "durationSource"::text = 'unknown'
      AND "durationMin" IS NOT NULL
    ORDER BY id`;
  const rows = all.filter((r) => !declined.has(r.id));
  console.log(
    `\n[attribute] ${all.length} active row(s) carrying a number stamped unknown` +
      `${declined.size ? ` (${all.length - rows.length} already declined, skipped)` : ''}`,
  );

  // The two re-derivable populations, and only those: a YouTube-hosted video (the
  // legacy path wrote the Data API's own number) and a Khan video (the same number
  // via the cached channel index). Everything else has no source to ask.
  const cached = readJson<KhanVideo[] | null>(INDEX_CACHE, null);
  const khanIndex = cached ? buildIndex(cached) : null;
  const byVideoId = new Map<string, Row[]>();
  const khanRows: Row[] = [];
  const noSource: Row[] = [];
  for (const row of rows) {
    const videoId = youtubeVideoId(row.url);
    if (videoId) byVideoId.set(videoId, [...(byVideoId.get(videoId) ?? []), row]);
    else if (khanIndex && /khanacademy\.org/.test(row.url)) khanRows.push(row);
    else noSource.push(row);
  }

  const ids = [...byVideoId.keys()];
  const durations = ids.length ? await youtubeDurations(ids) : new Map<string, number>();
  const quota = Math.ceil(ids.length / 50);

  const stamped: string[] = [];
  const stillUnknown: Row[] = [...noSource];

  for (const [videoId, group] of byVideoId) {
    const seconds = durations.get(videoId);
    const rederived = seconds == null ? null : secondsToMinutes(seconds);
    for (const row of group) {
      if (attributeByRederivation(row.durationMin, rederived)) stamped.push(row.id);
      else stillUnknown.push(row);
    }
  }

  for (const row of khanRows) {
    // Title key only: the slug key is the one that may not write unattended, and
    // stamping a provenance is a write.
    const hit = khanIndex ? proposeBySlug(khanIndex, row) : null;
    const rederived =
      hit && hit.kind === 'agreed' ? secondsToMinutes(hit.video.durationSeconds) : null;
    if (attributeByRederivation(row.durationMin, rederived)) stamped.push(row.id);
    else stillUnknown.push(row);
  }

  if (apply && stamped.length) {
    await prisma.resource.updateMany({
      where: { id: { in: stamped } },
      data: { durationSource: 'api' },
    });
  }
  if (apply) writeJson(DECLINED, [...declined, ...stillUnknown.map((r) => r.id)].sort());

  console.log(
    `  re-derivable sources: ${byVideoId.size} YouTube video id(s), ${khanRows.length} Khan row(s),` +
      ` ${noSource.length} row(s) with no source to ask\n` +
      `  attributed (the source reproduces the stored number exactly): ${stamped.length}\n` +
      `  left unknown, unattributable by construction: ${stillUnknown.length}\n` +
      `  YouTube quota spent: ${quota} unit(s)`,
  );
}

// ── reporting ────────────────────────────────────────────────────────────────

async function report(label: string) {
  const [totals] = await prisma.$queryRaw<{ nulls: number; numbered: number }[]>`
    SELECT COUNT(*) FILTER (WHERE "durationMin" IS NULL)::int AS nulls,
           COUNT(*) FILTER (WHERE "durationMin" IS NOT NULL AND "durationSource"::text = 'unknown')::int AS numbered
    FROM "Resource" WHERE status::text = 'active'`;
  console.log(
    `\n=== ${label}: active rows — no duration: ${totals.nulls} | number stamped unknown: ${totals.numbered}`,
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const retryDeclined = process.argv.includes('--retry-declined');
  const passArg = process.argv.find((a) => a.startsWith('--pass='));
  const passes = new Set((passArg?.slice('--pass='.length) ?? 'khan-slug,attribute').split(','));

  console.log(`\n=== resolve-unknowns (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  requireTargetAck('resolve-unknowns', apply, 'REWRITE duration provenance');
  await report('BEFORE');

  if (passes.has('khan-slug')) await khanSlugPass(apply);
  if (passes.has('attribute')) await attributePass(apply, retryDeclined);

  await report('AFTER');
  if (!apply) console.log('\nDry run only — nothing was written. Re-run with --apply.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
