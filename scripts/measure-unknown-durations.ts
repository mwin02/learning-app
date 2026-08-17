// Step 0 of the unknown-duration backfill — the measurement that decides what the
// remaining passes are worth building. READ-ONLY: no --apply, no writes, no network.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/measure-unknown-durations.ts
//   npx tsx --env-file=.env.local scripts/measure-unknown-durations.ts     # local Docker DB
//
// It exists because the population was described from three different runs' stdout
// and those runs answered different questions. Two conflations to break here:
//
//   1. `rederive-durations.ts` has five passes (khan, lamar, ocw, containers, books)
//      and NO pass for react.dev, docs.python.org, MDN, … or for a bare youtube.com
//      row — `youtubeDurations()` is called only from khanPass and ocwPass. Those
//      hosts were never attempted, so they are not residue.
//   2. `resolve-unknowns.ts`'s declined ledger records rows whose stored number could
//      not be ATTRIBUTED. That is not "no duration is obtainable" — for a youtube.com
//      row the Data API returned a duration and the pass discarded it as irrelevant to
//      attribution. A recovery pass must not read that ledger as a skip list, so the
//      overlap is reported here rather than left to be assumed either way.
//
// The number state matters as much as the count: a row at the placeholder 20 is
// storing a WRONG number that the allocator spends as though measured, while a null
// is costed at its type's median (`allocate.ts:effectiveDurationMin`). Absent and
// wrong are different defects and are never summed into one figure below.

import { existsSync, readFileSync } from 'node:fs';
import { prisma } from '../src/lib/db';
import { resolveTarget } from './target-guard';

const DECLINED = 'docs/audits/duration-attribution-declined.json';
const PLACEHOLDER = 20;

// The hosts group 1 is made of: server-rendered HTML whose prose is in the bytes, so
// a word-count estimator is buildable for them. Kept as a list rather than inferred
// so the report says which hosts a proposed pass would actually cover.
const STATIC_PROSE_HOSTS = [
  'react.dev',
  'docs.python.org',
  'freecodecamp.org',
  'pandas.pydata.org',
  'scikit-learn.org',
  'developer.mozilla.org',
  'openstax.org',
  'openlearninglibrary.mit.edu',
];

type NumberState = 'null' | 'placeholder' | 'other';

type Row = {
  id: string;
  host: string;
  type: string;
  durationMin: number | null;
};

function numberState(durationMin: number | null): NumberState {
  if (durationMin == null) return 'null';
  return durationMin === PLACEHOLDER ? 'placeholder' : 'other';
}

function tallyBy<K extends string>(rows: Row[], key: (r: Row) => K) {
  const out = new Map<K, { total: number; null: number; placeholder: number; other: number }>();
  for (const row of rows) {
    const k = key(row);
    const cell = out.get(k) ?? { total: 0, null: 0, placeholder: 0, other: 0 };
    cell.total += 1;
    cell[numberState(row.durationMin)] += 1;
    out.set(k, cell);
  }
  return [...out.entries()].sort((a, b) => b[1].total - a[1].total);
}

function printTable(title: string, rows: [string, { total: number; null: number; placeholder: number; other: number }][]) {
  console.log(`\n${title}`);
  console.log(`  ${'key'.padEnd(32)} ${'total'.padStart(6)} ${'null'.padStart(6)} ${'@20'.padStart(6)} ${'other'.padStart(6)}`);
  for (const [key, c] of rows) {
    console.log(
      `  ${key.padEnd(32)} ${String(c.total).padStart(6)} ${String(c.null).padStart(6)} ` +
        `${String(c.placeholder).padStart(6)} ${String(c.other).padStart(6)}`,
    );
  }
}

async function main() {
  const target = resolveTarget();
  console.log(`\n=== measure-unknown-durations (READ-ONLY) ===`);
  console.log(`[measure-unknown-durations] target: ${target.label}${target.isLocal ? '' : '  ⚠ REMOTE'}`);

  // Host is derived in SQL so the grouping matches what a pass's `url ~ '…'` selector
  // would actually match, and `www.`/`m.` are folded for the same reason. The scheme is
  // kept for anything that is not http(s): Phase 2g's on-ramp rows carry synthetic
  // `generated://<topic>` urls, and rendering those as a bare `calculus` puts a thing
  // no pass can ever fetch in the same column as a real site.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id,
           CASE WHEN url ~ '^https?://'
                THEN regexp_replace(substring(url from '^[a-z]+://([^/:]+)'), '^(www|m)\.', '')
                ELSE substring(url from '^([a-z]+://)') || coalesce(substring(url from '^[a-z]+://([^/:]+)'), '?')
           END AS host,
           type::text AS type,
           "durationMin"
    FROM "Resource"
    WHERE status::text = 'active'
      AND "durationSource"::text = 'unknown'
    ORDER BY id`;

  const [overall] = await prisma.$queryRaw<{ active: number }[]>`
    SELECT COUNT(*)::int AS active FROM "Resource" WHERE status::text = 'active'`;

  const states = { null: 0, placeholder: 0, other: 0 };
  for (const r of rows) states[numberState(r.durationMin)] += 1;

  console.log(
    `\nactive rows: ${overall.active}` +
      `\nstamped 'unknown': ${rows.length} (${((rows.length / overall.active) * 100).toFixed(1)}%)` +
      `\n  no number at all (null):        ${states.null}` +
      `\n  the placeholder 20 (WRONG, spent as measured): ${states.placeholder}` +
      `\n  some other number, unattributed: ${states.other}`,
  );

  printTable('by host', tallyBy(rows, (r) => r.host).slice(0, 20));
  printTable('by type', tallyBy(rows, (r) => r.type));

  // ── the four groups, counted as the passes would select them ────────────────

  const isKhan = (r: Row) => /khanacademy\.org$/.test(r.host);
  const groups: [string, (r: Row) => boolean][] = [
    ['1 static prose hosts', (r) => STATIC_PROSE_HOSTS.some((h) => r.host === h || r.host.endsWith(`.${h}`))],
    ['2 khan video', (r) => isKhan(r) && r.type === 'video'],
    ['3 khan article/interactive', (r) => isKhan(r) && (r.type === 'article' || r.type === 'interactive')],
    ['4a youtube.com', (r) => r.host === 'youtube.com' || r.host === 'youtu.be'],
    ['4b ocw.mit.edu', (r) => r.host === 'ocw.mit.edu'],
  ];
  const claimed = new Set<string>();
  const groupRows: [string, { total: number; null: number; placeholder: number; other: number }][] = [];
  for (const [label, pred] of groups) {
    const matched = rows.filter((r) => !claimed.has(r.id) && pred(r));
    for (const r of matched) claimed.add(r.id);
    groupRows.push([label, tallyBy(matched, () => 'x')[0]?.[1] ?? { total: 0, null: 0, placeholder: 0, other: 0 }]);
  }
  const rest = rows.filter((r) => !claimed.has(r.id));
  groupRows.push(['— unclassified', tallyBy(rest, () => 'x')[0]?.[1] ?? { total: 0, null: 0, placeholder: 0, other: 0 }]);
  printTable('by group (first match wins, so the groups partition the population)', groupRows);

  if (rest.length) printTable('  unclassified, by host', tallyBy(rest, (r) => r.host).slice(0, 15));

  // ── what each proposed pass would actually see ──────────────────────────────

  // `rederive-durations.ts`'s resume selector is `durationSource='unknown' AND
  // durationMin = 20`; --retry-unknown widens it to nulls. A row already written to
  // null/unknown by an earlier pass is invisible to a default re-run, which is the
  // single most likely explanation for the OCW residue.
  const ocw = rows.filter((r) => r.host === 'ocw.mit.edu');
  const ocwDefault = ocw.filter((r) => r.durationMin === PLACEHOLDER).length;
  console.log(
    `\nocw.mit.edu re-run reach:` +
      `\n  visible to the DEFAULT selector (durationMin = 20): ${ocwDefault}` +
      `\n  reachable only with --retry-unknown (durationMin IS NULL): ${ocw.filter((r) => r.durationMin == null).length}` +
      `\n  invisible to both (some other number): ${ocw.filter((r) => r.durationMin != null && r.durationMin !== PLACEHOLDER).length}`,
  );

  // ── the declined ledger's true scope ────────────────────────────────────────

  if (existsSync(DECLINED)) {
    const declined = new Set(JSON.parse(readFileSync(DECLINED, 'utf8')) as string[]);
    const overlap = rows.filter((r) => declined.has(r.id));
    const yt = overlap.filter((r) => r.host === 'youtube.com' || r.host === 'youtu.be');
    console.log(
      `\ndeclined ledger (${DECLINED}): ${declined.size} id(s)` +
        `\n  still unknown in this database: ${overlap.length}` +
        `\n  of those, youtube-hosted — a Data API duration EXISTS for these and was` +
        `\n    discarded as irrelevant to attribution: ${yt.length}`,
    );
  } else {
    console.log(`\ndeclined ledger: ${DECLINED} not on disk (it is git-ignored and local to whoever ran the driver)`);
  }

  // ── the floor, stated rather than implied ───────────────────────────────────

  const khanUnreachable = rows.filter((r) => isKhan(r) && r.type !== 'video').length;
  console.log(
    `\nstructurally unreachable by automation (Khan bot wall, non-video): ${khanUnreachable}` +
      `\n  — B4's rule: this number is reported, not minimised. Reviewer clicks are its only path.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
