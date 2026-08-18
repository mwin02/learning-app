// How does the library fail `resource-standard.md`? READ-ONLY, and there is no write flag.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/report-serveability.ts
//   npx tsx --env-file=.env.local scripts/report-serveability.ts     # local Docker DB
//
// Replaces `census-serveability.ts`, which measured the same library with hand-copied
// row-level rules and no page evidence. Everything that script printed is printed below,
// now derived from the three real classifiers — `classifyServeability` (clauses 3/5 from
// stored fields), `classifyServeabilityFromProbe` (clauses 4/5 from the rendered page) and
// `classifyMetadataIntegrity` (clause 6) — so the report and the sweep that reads it cannot
// disagree about a population, which two copies of a regex eventually would.
//
// Every figure in `resource-serveability.md`'s diagnosis is reproducible from here.
//
// ⚠️ ITS PAGE EVIDENCE IS NOT REPRODUCIBLE FROM A FRESH CLONE. The 526 Khan probe
// artifacts live in `docs/audits/khan-batch-*.json*`, which is git-ignored: they exist only
// on the machine that ran the duration backfill. So this report is disposable output over
// local inputs, on the same footing that backfill ran on. On a machine without them every
// page-level rule reports "no evidence" — which is counted and named below rather than
// quietly read as a pass, because a row nobody has looked at has not been cleared.
//
// ⚠️ KHAN-ONLY on the page-level clauses. The probe is Khan-shaped (`.perseus-article`), so
// ~1,200 non-Khan rows are unmeasured on clauses 4, 5 and 6's page comparisons. Deliberate
// and deferred; the row-level half below is host-agnostic and covers everything.
//
// This block reports and stops. Nothing here decides what to deprecate or re-type — S8 does,
// against this population.

import { readdirSync, readFileSync } from 'node:fs';
import type { DecompositionStatus, ResourceStatus, ResourceType } from '@prisma/client';
import { MIN_CONTENT_WORDS } from '../src/lib/curation/duration-estimate';
import {
  classifyMetadataIntegrity,
  type MetadataDiscrepancy,
} from '../src/lib/curation/metadata-integrity';
import { classifyServeability, urlKind } from '../src/lib/curation/serveability';
import {
  classifyServeabilityFromProbe,
  type ProbeEvidence,
} from '../src/lib/curation/serveability-probe';
import { prisma } from '../src/lib/db';
import { resolveTarget } from './target-guard';

const BATCH_DIR = 'docs/audits';
const BATCH_FILE = /^khan-batch-.+\.jsonl?$/;

type BatchRow = {
  resourceId: string;
  url: string;
  probe: ProbeEvidence | null;
  status: 'ok' | 'failed';
};

type Row = {
  id: string;
  url: string;
  title: string;
  type: ResourceType;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
};

type Failure = { clause: number; rule: string };

type Analysis = {
  row: Row;
  pickable: boolean;
  attached: boolean;
  // 'none' = never probed; 'failed'/'blocked' = probed and we still have no page.
  evidence: 'ok' | 'none' | 'failed' | 'blocked';
  failures: Failure[];
  discrepancies: MetadataDiscrepancy[];
};

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // A malformed URL is a finding, not a crash — it must still appear in the tally.
    return '(unparseable)';
  }
}

const isKhan = (url: string) => /(^|\.)khanacademy\.org$/.test(host(url));

// What retrieval can serve today. Derived, never stored — see the Resource comment in
// schema.prisma on why there is no `pickable` column.
const isPickable = (r: Row) => r.status === 'active' && r.decompositionStatus === 'atomic';

function readBatches(): Map<string, BatchRow> {
  // Sorted filenames and last-write-wins, so a resource probed twice resolves the same way
  // on every run. Nothing here reads a clock or a directory order.
  const byResource = new Map<string, BatchRow>();
  for (const f of readdirSync(BATCH_DIR).filter((f) => BATCH_FILE.test(f)).sort()) {
    const raw = readFileSync(`${BATCH_DIR}/${f}`, 'utf8');
    const rows: BatchRow[] = f.endsWith('.jsonl')
      ? raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      : JSON.parse(raw);
    for (const r of rows) byResource.set(r.resourceId, r);
  }
  return byResource;
}

// all / pickable / pickable-and-attached — the three numbers every population needs. The
// first says how much is in the table, the second how much retrieval can reach, and the
// third is the only one that costs anything to remove.
function counts(rows: Analysis[]): string {
  const pick = rows.filter((a) => a.pickable);
  const att = pick.filter((a) => a.attached);
  return `${String(rows.length).padStart(5)} / ${String(pick.length).padStart(5)} / ${String(att.length).padStart(5)}`;
}

function line(label: string, rows: Analysis[]) {
  console.log(`  ${counts(rows)}  ${label}`);
}

function tally(rows: Analysis[], key: (a: Analysis) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  // Count descending, then key ascending — a pure tie must not order by insertion.
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printTally(title: string, entries: [string, number][]) {
  console.log(`\n${title}`);
  for (const [k, v] of entries) console.log(`  ${String(v).padStart(6)}  ${k}`);
}

function section(title: string) {
  console.log(`\n${'─'.repeat(100)}\n${title}`);
}

const flags = (a: Analysis) => `${a.pickable ? 'pickable' : '        '} ${a.attached ? 'attached' : '        '}`;

function repairOf(d: MetadataDiscrepancy): string {
  return d.repair === 'retype' ? `retype ${d.to}` : 'review';
}

function analyse(row: Row, batch: BatchRow | undefined, attached: Set<string>): Analysis {
  const probe = batch && batch.status === 'ok' ? batch.probe : null;
  const failures: Failure[] = [];

  const verdict = classifyServeability(row);
  if (!verdict.serveable) failures.push({ clause: verdict.clause, rule: verdict.reason });

  const fromProbe = classifyServeabilityFromProbe(probe, { url: row.url, title: row.title });
  if (fromProbe.evidence && !fromProbe.serveable) {
    failures.push({ clause: fromProbe.clause, rule: fromProbe.reason });
  }

  const meta = classifyMetadataIntegrity(row, probe);
  const discrepancies = meta.pageChecked ? meta.discrepancies : meta.rowDiscrepancies;

  const evidence: Analysis['evidence'] = !batch
    ? 'none'
    : batch.status === 'failed' || !batch.probe
      ? 'failed'
      : batch.probe.blocked
        ? 'blocked'
        : 'ok';

  return {
    row,
    pickable: isPickable(row),
    attached: attached.has(row.id),
    evidence,
    failures,
    discrepancies,
  };
}

async function main() {
  console.log(`\n=== report-serveability (READ-ONLY) ===`);
  const target = resolveTarget();
  console.log(`[report-serveability] target: ${target.label}${target.isLocal ? '' : '  ⚠ REMOTE'}`);

  const rows = await prisma.resource.findMany({
    select: { id: true, url: true, title: true, type: true, status: true, decompositionStatus: true },
    orderBy: { id: 'asc' },
  });
  const attached = new Set(
    (await prisma.conceptResource.findMany({ select: { resourceId: true }, distinct: ['resourceId'] }))
      .map((r) => r.resourceId),
  );
  const batches = readBatches();
  const all = rows.map((r) => analyse(r, batches.get(r.id), attached));

  const pickable = all.filter((a) => a.pickable);
  console.log(
    `\n${all.length} resource rows` +
      `\n${pickable.length} pickable (active + atomic)` +
      `\n${attached.size} rows attached to at least one concept` +
      `\n${batches.size} probe artifact(s) on disk, ${all.filter((a) => a.evidence !== 'none').length} of them matching a live row`,
  );

  // ── the library, as the census described it ────────────────────────────────
  section('POPULATION');
  printTally('ALL ROWS by type', tally(all, (a) => a.row.type));
  printTally('PICKABLE by type', tally(pickable, (a) => a.row.type));
  const khan = all.filter((a) => isKhan(a.row.url));
  console.log(`\nKHAN rows: ${khan.length} (pickable: ${khan.filter((a) => a.pickable).length})`);
  printTally('KHAN all rows by URL kind', tally(khan, (a) => urlKind(a.row.url) ?? '(container/unit page)'));
  printTally(
    'KHAN pickable by URL kind + stored type',
    tally(khan.filter((a) => a.pickable), (a) => `${urlKind(a.row.url) ?? '(none)'}  type=${a.row.type}`),
  );

  // ── what evidence exists, stated before any verdict is read ────────────────
  //
  // A page-level clause can only fail on a row somebody looked at, so every count in the
  // next section is bounded by this one. Reporting it first is the difference between "the
  // library passes clause 4" and "we have never opened 1,783 of these pages".
  section('PAGE EVIDENCE (a row with none is NOT a pass)');
  line('probed, page read', all.filter((a) => a.evidence === 'ok'));
  line('probed, agent reported failure', all.filter((a) => a.evidence === 'failed'));
  line('probed, page reported blocked — a bot wall is not a quality failure', all.filter((a) => a.evidence === 'blocked'));
  line('NO PROBE ARTIFACT — unmeasured on clauses 4, 5 (page half) and 6 (page half)', all.filter((a) => a.evidence === 'none'));
  line('  of those, Khan rows (probeable today)', all.filter((a) => a.evidence === 'none' && isKhan(a.row.url)));
  line('  of those, non-Khan rows (no probe exists for these hosts)', all.filter((a) => a.evidence === 'none' && !isKhan(a.row.url)));

  // ⚠️ 20 early artifacts (khan-batch-01..04) predate the `widgets` field. The practice-page
  // rule is strictly paired — prose under the floor AND ≥1 widget — so with no widget count
  // it cannot fire, and such a row is classified SERVEABLE. That is correct behaviour (a
  // missing measurement must not exclude) and it means the practice-page count below lands
  // short of what a full re-probe would find. `basic-normal-calculations`, the canonical
  // 189-words-around-6-widgets page, is one of them. Reported, not fixed.
  const noWidgets = all.filter((a) => a.evidence === 'ok' && batches.get(a.row.id)?.probe?.widgets == null);
  line('probed BEFORE the `widgets` field existed — practice-page rule cannot fire on these', noWidgets);
  for (const a of noWidgets.filter((a) => {
    const w = batches.get(a.row.id)?.probe?.articleWords;
    return w != null && w < MIN_CONTENT_WORDS;
  })) {
    console.log(`      under the prose floor, so a widget count would have decided it: ${a.row.url}`);
  }

  // ── the standard, clause by clause ─────────────────────────────────────────
  section('FAILURES BY CLAUSE AND RULE (all / pickable / pickable+attached)');
  const clauses = [...new Set(all.flatMap((a) => a.failures.map((f) => f.clause)))].sort();
  for (const clause of clauses) {
    console.log(`\n clause ${clause}`);
    const inClause = all.filter((a) => a.failures.some((f) => f.clause === clause));
    const rules = [...new Set(inClause.flatMap((a) => a.failures.filter((f) => f.clause === clause).map((f) => f.rule)))].sort();
    for (const rule of rules) {
      line(rule, inClause.filter((a) => a.failures.some((f) => f.clause === clause && f.rule === rule)));
    }
    line(`— clause ${clause} total (rows, deduplicated)`, inClause);
  }

  const failing = all.filter((a) => a.failures.length > 0);
  console.log('');
  line('— ANY serveability clause (rows, deduplicated across clauses)', failing);

  // ── clause 6, whose remedy is the opposite one ─────────────────────────────
  section('CLAUSE 6 — METADATA INTEGRITY (repair, never removal)');
  const withDiscrepancy = all.filter((a) => a.discrepancies.length > 0);
  const rules6 = [...new Set(withDiscrepancy.flatMap((a) => a.discrepancies.map((d) => `${d.kind}  →  ${repairOf(d)}`)))].sort();
  for (const rule of rules6) {
    line(rule, withDiscrepancy.filter((a) => a.discrepancies.some((d) => `${d.kind}  →  ${repairOf(d)}` === rule)));
  }
  line('— clause 6 total (rows, deduplicated)', withDiscrepancy);

  // Counted as ROWS, never as findings: S4's comparisons 1 and 2 both fire on the same
  // defect when they agree, and a row is repaired once.
  const retypeRows = withDiscrepancy.filter((a) => a.discrepancies.some((d) => d.repair === 'retype'));
  const reviewOnlyRows = withDiscrepancy.filter((a) => !a.discrepancies.some((d) => d.repair === 'retype'));
  const disagreeing = retypeRows.filter(
    (a) => new Set(a.discrepancies.filter((d) => d.repair === 'retype').map((d) => d.to)).size > 1,
  );

  console.log('\n  REPAIR SPLIT (all / pickable / pickable+attached)');
  line('re-type — the evidence names the form the row should have carried', retypeRows);
  line('review only — real finding, but it does not say what the row should become', reviewOnlyRows);
  line('deprecate — fails a serveability clause with NO clause-6 re-type to repair it first', failing.filter((a) => !retypeRows.includes(a)));
  line('re-type OUTRANKS a serveability failure on these rows (kept, corrected, not removed)', failing.filter((a) => retypeRows.includes(a)));
  if (disagreeing.length) {
    line('⚠ ESCALATION — two re-type findings naming DIFFERENT targets, no winner picked here', disagreeing);
    for (const a of disagreeing) console.log(`      ${a.row.id}  ${a.row.url}`);
  }

  console.log('\n  EVERY CLAUSE-6 ROW WITH ITS IMPLIED REPAIR');
  for (const a of withDiscrepancy) {
    for (const d of a.discrepancies) {
      console.log(`  ${repairOf(d).padEnd(15)} ${flags(a)}  ${d.detail}`);
      console.log(`  ${' '.repeat(32)}  ${a.row.url}`);
    }
  }

  // ── the census's own rejected alternatives, kept visible ───────────────────
  section('MEASURED BUT DELIBERATELY NOT EXCLUDED (all / pickable / pickable+attached)');
  line('khan "… review" article — teaches in prose, largest false-positive population if excluded',
    all.filter((a) => isKhan(a.row.url) && /review[^/]*$/.test(a.row.url)));
  line('probed article clearing the prose floor while carrying ≥10 widgets — over the floor is over the floor',
    all.filter((a) => {
      const p = batches.get(a.row.id)?.probe;
      return a.evidence === 'ok' && p?.articleWords != null && p.articleWords >= MIN_CONTENT_WORDS && (p.widgets ?? 0) >= 10;
    }));

  // ── the hosts nobody has opened ────────────────────────────────────────────
  //
  // EVERY non-Khan interactive row, individually, because this population is where the
  // exclusion actually costs something and a count cannot be read for it. Khan's are
  // excluded from the listing only because their kind segment already says what they are
  // (`/pi/`, `/pt/`) and they are enumerated by rule above; every other host is a row
  // somebody has to look at.
  //
  // Two of these are ATTACHED, and the plan's diagnosis says those two are the entire human
  // cost of the exclusion — a hole remediation has to refill. An operator running the sweep
  // must be able to see both by name without going back to the database.
  //
  // ⚠️ The MITx 6.036 rows are all `…+type@sequential+block@<name>` URLs, and an edX
  // `sequential` is a UNIT CONTAINING SEVERAL CHILD PAGES — so their repair may be a
  // decompose (clause 3) rather than the re-type-or-deprecate split the plan assumed. That
  // is why the stored `decompositionStatus` is printed beside every row. NOTHING IS DECIDED
  // HERE, on that host or any other.
  section('NON-KHAN type=interactive — listed individually, decided by nobody here');
  const interactive = all
    .filter((a) => a.row.type === 'interactive' && !isKhan(a.row.url))
    // Host, then id — `all` is already id-ascending and the sort is stable, so two runs
    // order these identically.
    .sort((a, b) => host(a.row.url).localeCompare(host(b.row.url)));
  console.log(
    `  ${interactive.length} rows (${interactive.filter((a) => a.pickable).length} pickable, ` +
      `${interactive.filter((a) => a.attached).length} attached)`,
  );
  for (const a of interactive) {
    console.log(
      `\n  ${flags(a)}  status=${a.row.status}  decompositionStatus=${a.row.decompositionStatus}` +
        `\n    ${a.row.title}` +
        `\n    ${a.row.url}`,
    );
  }

  console.log(`\n${'─'.repeat(100)}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
