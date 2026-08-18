// Khan duration backfill — the write path for the browser-measured batches.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/apply-khan-durations.ts
//   … --apply --target-host=aws-1-us-west-1.pooler.supabase.com
//   … --batches='docs/audits/khan-batch-pilot.json'
//
// The batch files are written by sub-agents driving a browser, so they are treated as
// untrusted input: zod-parsed on the way in, and every derived number goes through the
// same `checkDuration` gate the decomposition write path uses. There is no second write
// path here on purpose.
//
// ── THE DIVISION OF LABOUR ───────────────────────────────────────────────────
//
// Agents report MEASUREMENTS; this script applies the FORMULAS. That split is the
// whole reason the numbers are trustworthy: `readingMinutes` is applied identically to
// all 144 articles from one place, instead of 15 agents each rounding their own way.
// An agent that returned a bare minute count would be indistinguishable from an agent
// that guessed one, which is the failure the `DurationSource` enum exists to prevent.
//
// ── PROVENANCE ───────────────────────────────────────────────────────────────
//
//   api        — a YouTube id read out of the page, resolved to an exact duration
//   extracted  — a word count of the rendered article body
//   unknown    — everything else, INCLUDING every page an agent could not read
//
// `reviewer` is never written here. It means a human measured the rendered page, it is
// the one tier no automated pass may overwrite, and an agent reading a page is not a
// human. Stamping it would poison the only trustworthy tier in the library.
//
// ── WHY A NULL IS NEVER WRITTEN ──────────────────────────────────────────────
//
// A row we failed to measure keeps whatever it has. Writing null over an existing
// number would turn an unattributed-but-plausible value into no value at all, which is
// a regression dressed as cleanup — the allocator costs a null at its type's median.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { prisma } from '../src/lib/db';
import { isoDurationToSeconds } from '../src/lib/curation/duration-estimate';
import {
  proposeKhanDuration,
  type KhanMeasured,
  type KhanUnmeasured,
} from '../src/lib/curation/khan-probe-duration';
import { urlKind } from '../src/lib/curation/serveability';
import { checkDuration } from '../src/lib/agents/decomposition/duration-rules';
import type { KhanVideo } from '../src/lib/sources/khan/youtube-index';
import { requireTargetAck } from './target-guard';

const INDEX_CACHE = 'docs/audits/khan-youtube-index.json';
const BATCH_DIR = 'docs/audits';
const BATCH_FILE = /^khan-batch-.+\.jsonl?$/;

// The snippet's output. `.passthrough()` is deliberate: an agent that reports an extra
// diagnostic field should not fail the batch, but every field this script READS is
// declared and typed, so a missing or wrong-typed one fails loudly instead of
// defaulting to a number.
const Probe = z
  .object({
    url: z.string(),
    title: z.string(),
    pageKind: z.string(),
    videoIds: z.array(z.string()),
    articleWords: z.number().int().nonnegative().nullable(),
    articleWordsBeforeExpand: z.number().int().nonnegative().nullable(),
    collapsedExpanded: z.number().int().nonnegative(),
    workedExamples: z.number().int().nonnegative().nullable(),
    // Optional: the pilot batch predates this field.
    widgets: z.number().int().nonnegative().optional(),
    mainWords: z.number().int().nonnegative(),
    hasEditor: z.boolean(),
    blocked: z.boolean(),
    bodyWords: z.number().int().nonnegative(),
  })
  .passthrough();

const BatchRow = z.object({
  resourceId: z.string().min(1),
  url: z.string(),
  storedType: z.enum(['video', 'article', 'interactive']),
  probe: Probe.nullable(),
  status: z.enum(['ok', 'failed']),
  note: z.string().default(''),
});

const Batch = z.array(BatchRow);

type BatchRow = z.infer<typeof BatchRow>;

type Proposal = { row: BatchRow } & (KhanMeasured | KhanUnmeasured);

type DbRow = {
  id: string;
  title: string;
  type: string;
  durationMin: number | null;
  decompositionStatus: string | null;
  childCount: number;
};

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

// ── the YouTube half ─────────────────────────────────────────────────────────

// The cached channel index already holds 9,310 Khan videos with exact durations, so a
// video id read from a page usually resolves for zero quota and zero network. The Data
// API is the fallback for ids the cache does not carry (a video published after the
// index was built, or one outside Khan's main channel).
async function youtubeDurations(videoIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    console.log('  ⚠ YOUTUBE_API_KEY is not set — uncached ids stay unknown rather than guessed');
    return out;
  }
  for (let i = 0; i < videoIds.length; i += 50) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('id', videoIds.slice(i, i + 50).join(','));
    url.searchParams.set('key', key);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) continue;
    const json = (await res.json()) as {
      items?: { id?: string; contentDetails?: { duration?: string } }[];
    };
    for (const v of json.items ?? []) {
      const seconds = v.contentDetails?.duration ? isoDurationToSeconds(v.contentDetails.duration) : null;
      if (v.id && seconds != null) out.set(v.id, seconds);
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`\n=== apply-khan-durations (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  requireTargetAck('apply-khan-durations', apply, 'REWRITE durations');

  const only = arg('batches');
  const files = only
    ? only.split(',')
    : readdirSync(BATCH_DIR)
        .filter((f) => BATCH_FILE.test(f))
        .map((f) => `${BATCH_DIR}/${f}`)
        .sort();
  if (files.length === 0) throw new Error(`no batch files in ${BATCH_DIR} matching ${BATCH_FILE}`);
  console.log(`\nbatch files: ${files.length}`);

  const rows: BatchRow[] = [];
  for (const f of files) {
    // `.jsonl` is the crash-safe form: an agent appends one row per line as it measures,
    // so a run killed midway (a session limit did exactly that to four agents) keeps every
    // page it already read. Rewriting a whole JSON array per row costs the agent quadratic
    // context for the same guarantee.
    const raw = readFileSync(f, 'utf8');
    const parsed = f.endsWith('.jsonl')
      ? Batch.safeParse(
          raw
            .split('\n')
            .filter((l) => l.trim())
            .map((l, i) => {
              try {
                return JSON.parse(l);
              } catch {
                throw new Error(`${f}:${i + 1} is not valid JSON — a partial line from an interrupted write?`);
              }
            }),
        )
      : Batch.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.error(`\n✗ ${f} is malformed:\n${z.prettifyError(parsed.error)}`);
      process.exit(1);
    }
    console.log(`  ${f}: ${parsed.data.length} row(s)`);
    rows.push(...parsed.data);
  }

  const seen = new Set<string>();
  const dupes = rows.filter((r) => !seen.add(r.resourceId)).map((r) => r.resourceId);
  if (dupes.length) throw new Error(`the same resource appears in two batches: ${dupes.join(', ')}`);

  // Resolve every video id first: the cache answers most of them for free, and the rest
  // go to the Data API in one batched call rather than one per row.
  const cache = new Map<string, number>(
    existsSync(INDEX_CACHE)
      ? (JSON.parse(readFileSync(INDEX_CACHE, 'utf8')) as KhanVideo[]).map((v) => [v.videoId, v.durationSeconds])
      : [],
  );
  // Every id a proposal could spend: the one id a video row resolves, and every clip an
  // article embeds (those count toward its duration). A row whose stored URL redirected
  // across content kinds is excluded — it is unknown regardless of what its page embeds,
  // so looking those ids up would spend quota on a number nothing reads.
  const wanted = new Set(
    rows.flatMap((r) => {
      if (r.status !== 'ok' || !r.probe) return [];
      if (urlKind(r.url) !== urlKind(r.probe.url)) return [];
      const isVideo = r.storedType === 'video' || r.probe.pageKind === 'video';
      if (isVideo) return r.probe.videoIds.length === 1 ? r.probe.videoIds : [];
      return r.probe.videoIds;
    }),
  );
  const missing = [...wanted].filter((id) => !cache.has(id));
  console.log(
    `\nvideo ids: ${wanted.size} unique — ${wanted.size - missing.length} from the cached index (0 quota), ${missing.length} to look up`,
  );
  for (const [id, secs] of await youtubeDurations(missing)) cache.set(id, secs);

  const proposals: Proposal[] = rows.map((row) => ({
    row,
    ...proposeKhanDuration(row.storedType, row.url, row.status === 'failed' ? null : row.probe, cache),
  }));

  // The DB is the authority on what may be written. `durationSource = 'unknown'` in the
  // selector is what makes it impossible for this script to touch a `reviewer` row, no
  // matter what a batch file claims. `childCount` comes along because `checkDuration`
  // silently loses its multi-unit floor when it is omitted — that bug was found and
  // fixed this week and is not being reintroduced.
  const ids = proposals.map((p) => p.row.resourceId);
  const db = new Map<string, DbRow>(
    (
      await prisma.$queryRaw<DbRow[]>`
        SELECT r.id, r.title, r.type::text AS type, r."durationMin",
               r."decompositionStatus"::text AS "decompositionStatus",
               (SELECT COUNT(*)::int FROM "Resource" c WHERE c."parentResourceId" = r.id) AS "childCount"
        FROM "Resource" r
        WHERE r.id = ANY(${ids}::text[])
          AND r.status::text = 'active'
          AND r."durationSource"::text = 'unknown'`
    ).map((r) => [r.id, r]),
  );

  const writes: { id: string; durationMin: number; durationSource: 'api' | 'extracted' }[] = [];
  const skipped: string[] = [];

  console.log(`\n── per-row diff ─────────────────────────────────────────────`);
  for (const p of proposals) {
    const row = db.get(p.row.resourceId);
    const label = `${p.row.resourceId}  ${p.row.storedType.padEnd(11)}`;

    if (!row) {
      skipped.push(`${label}  NOT SELECTABLE — inactive, or no longer stamped unknown (a reviewer may have reached it)`);
      continue;
    }
    if (p.durationMin == null) {
      // The row keeps whatever it has. Never a null over a number, and never a null
      // over a null either — there is nothing to write.
      skipped.push(`${label}  unknown — ${p.evidence}`);
      continue;
    }

    const verdict = checkDuration({
      type: row.type,
      durationMin: p.durationMin,
      decompositionStatus: row.decompositionStatus ?? undefined,
      childCount: row.childCount,
    });
    if (!verdict.ok) {
      skipped.push(`${label}  REJECTED by checkDuration — ${verdict.reason}`);
      continue;
    }

    console.log(
      `  ${label}  ${String(row.durationMin ?? 'null').padStart(4)} → ${String(p.durationMin).padStart(4)} min` +
        `  [${p.durationSource}]  ${p.evidence}\n` +
        `      ${row.title.slice(0, 88)}`,
    );
    writes.push({ id: row.id, durationMin: p.durationMin, durationSource: p.durationSource });
  }

  if (skipped.length) {
    console.log(`\n── left unknown (${skipped.length}) ─────────────────────────`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  const bySource = new Map<string, number>();
  for (const w of writes) bySource.set(w.durationSource, (bySource.get(w.durationSource) ?? 0) + 1);
  console.log(
    `\n── summary ──────────────────────────────────────────────────\n` +
      `  rows in batches:   ${rows.length}\n` +
      `  would write:       ${writes.length}` +
      `  (${[...bySource].map(([s, n]) => `${n} ${s}`).join(', ') || '—'})\n` +
      `  left unknown:      ${skipped.length}  — reported, not minimised\n`,
  );

  if (!apply) {
    console.log('Dry run only — nothing was written. Read the diff above, then re-run with --apply.\n');
    return;
  }

  // One row at a time: `updateMany` cannot give each row its own number, and a
  // transaction over hundreds of writes against the pooler buys nothing here — a
  // partial application is resumable, because a written row drops out of the
  // `durationSource = 'unknown'` selector on the next run.
  for (const w of writes) {
    await prisma.resource.update({
      where: { id: w.id },
      data: { durationMin: w.durationMin, durationSource: w.durationSource },
    });
  }
  console.log(`✓ wrote ${writes.length} row(s).\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
