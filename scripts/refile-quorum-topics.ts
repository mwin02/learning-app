// Topic filing T4b — the quorum seed/mint pass. THE ONLY PASS THAT MOVES PRIMARIES.
//
// T4a re-scored 1,152 rows and refused to refile any of them, because for 383 of those
// rows the shelf the classifier named was EMPTY and for 62 the subject was missing from
// the vocabulary entirely. Filing a handful of rows onto an empty shelf strands them:
// k-NN can only vouch for a topic holding a plurality among 10 neighbours, so a shelf
// under MIN_VOUCHABLE_POOL is one the guardrail permanently distrusts, and a shelf that
// is never vouched for never fills. This driver breaks that deadlock the only way it
// can be broken — by moving a whole cohort at once, so the shelf clears the bar the
// moment it exists. The decision matrix is pure and lives (with its tests) in
// src/lib/curation/quorum-refile.ts; this is the operator surface.
//
// TWO PHASES, and the order between them is load-bearing:
//
//   1. REFILE. Reads the T4a audit record — no classifier, no k-NN. Every number it
//      needs was measured then, so the record IS the snapshot: this phase reads no live
//      neighbour labels and therefore cannot be perturbed by its own writes. (T4a got
//      that property from never refiling; here it comes from never re-deriving.)
//   2. SETTLE. Runs strictly AFTER every write in phase 1, re-measures each moved row
//      against the now-populated shelf, and clears `contested` where the guardrail
//      finally vouches. It writes only `relevance`/`contested`, never `Resource.topic`,
//      so it cannot move the evidence it is reading either.
//
// Phase 2 is not cleanup — it is this block's acceptance measurement. Without it 445 rows
// sit at a measured-looking `relevance: 0.0`, which is exactly what a future origin-aware
// `minRelevance` gates hardest.
//
// Run:
//   npx tsx --env-file=.env.local scripts/refile-quorum-topics.ts --from=docs/audits/reclassify-t4a.json
//   ... --apply
//   ... --apply --only=precalculus            # one cohort at a time
//   ... --apply --out=docs/audits/refile-t4b.json
//
// ⚠️ Stop the compose workers first (`docker compose --profile workers stop worker`) —
// this moves primaries under topics a live sourcing run may be filing into, and a worker
// that files a row mid-pass would trip the drift guard at best.

import { readFile, writeFile } from 'node:fs/promises';
import { prisma } from '../src/lib/db';
import { listCanonicals } from '../src/lib/agents/topic-registry';
import { createTopicMinter } from '../src/lib/curation/topic-mint';
import { knnNeighbourTopicsOf, purity, plurality, topicPools } from '../src/lib/curation/topic-knn';
import {
  applyReclassification,
  settleMembership,
  assertMembershipInvariants,
} from '../src/lib/curation/resource-topics';
import {
  selectQuorumSlate,
  decideRefile,
  decideSettlement,
  QUORUM,
  type RefileRecord,
  type QuorumCandidate,
  type RefileSkip,
} from '../src/lib/curation/quorum-refile';

// Phase-2 reads in flight. One indexed pgvector lookup each, so this is latency- not
// CPU-bound; 8 keeps a few hundred round-trips to a remote DB from dominating the run.
const CONCURRENCY = 8;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

type Moved = { id: string; title: string; from: string; to: string; label: string };
type Skipped = { id: string; title: string; reason: RefileSkip | 'live-drift'; detail: string };

async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all([...Array(CONCURRENCY)].map(worker));
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const from = arg('from') ?? 'docs/audits/reclassify-t4a.json';
  const only = arg('only')?.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

  const parsed = JSON.parse(await readFile(from, 'utf8')) as { runAt: string; rows: RefileRecord[] };
  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`record: ${from} (${parsed.rows.length} decisions from ${parsed.runAt})`);
  console.log(`quorum: ${QUORUM} (= MIN_VOUCHABLE_POOL)\n`);

  const slate = selectQuorumSlate(parsed.rows);

  const table = (title: string, cohorts: QuorumCandidate[]) => {
    if (cohorts.length === 0) return;
    console.log(`${title}:`);
    for (const c of cohorts) {
      console.log(`  ${String(c.rows.length).padStart(4)}  ${c.channel.padEnd(5)} ${c.label}`);
    }
    console.log('');
  };
  table('clears quorum', slate.clears);
  // Never acted on — these rows keep the primary T4a left them with. Printed so the tally
  // is auditable and so a label creeping up on the bar is visible run over run.
  table('below quorum (untouched)', slate.below);

  const selected = only
    ? slate.clears.filter((c) => only.includes(c.label))
    : slate.clears;
  if (only) console.log(`--only: ${selected.length} of ${slate.clears.length} cohorts selected\n`);
  if (selected.length === 0) {
    console.log('nothing to refile.\n');
    await assertMembershipInvariants();
    return;
  }

  // ── resolve each cohort's target topic ──────────────────────────────────────
  //
  // A seed's label is already a canonical (T4a took it from a proposal the classifier had
  // filtered to `listCanonicals()`), so it is its own target — the assertion below is a
  // cheap guard against that provenance changing, not a real branch.
  //
  // A mint's label is a raw model-proposed slug that has NEVER been through the gate.
  // Filing under it directly would bypass domain rejection, `toCanonicalSlug`, and T1.5's
  // snap-to-curated-slug guard — i.e. re-open the twin-minting hole T1.5 closed. It goes
  // through `createTopicMinter` (T3's memoized wrapper) instead, so this pass adds no
  // second minting path.
  const canonicals = new Set(await listCanonicals());
  const mint = createTopicMinter();
  const targets = new Map<QuorumCandidate, string>();
  for (const cohort of selected) {
    if (cohort.channel === 'seed') {
      if (!canonicals.has(cohort.label)) {
        console.log(`  ⚠️  seed label is not a canonical, skipping cohort: ${cohort.label}`);
        continue;
      }
      targets.set(cohort, cohort.label);
      continue;
    }
    if (!apply) {
      // The gate PERSISTS an alias, so calling it would be a write. A dry run reports the
      // raw label and stops short of minting it.
      console.log(`  mint ${cohort.label}: gate not called in dry-run`);
      targets.set(cohort, cohort.label);
      continue;
    }
    const canonical = await mint(cohort.label);
    if (!canonical) {
      console.log(`  ⚠️  gate declined "${cohort.label}" — cohort skipped (${cohort.rows.length} rows)`);
      continue;
    }
    if (canonical !== cohort.label) {
      console.log(`  mint ${cohort.label} → ${canonical} (gate coerced or snapped)`);
    }
    targets.set(cohort, canonical);
  }
  console.log('');

  // ── phase 1: refile ─────────────────────────────────────────────────────────
  //
  // The drift guard. `Resource.topic` is the mirror of the primary membership, so
  // comparing it against what T4a recorded catches anything that moved the row since —
  // a live worker, a manual review, or (the common case) a previous run of THIS pass.
  // That last one is why the guard exists: it makes a re-run a reported no-op rather than
  // a second move, and a crashed run resumable with the same command.
  const cohortRows = [...targets.keys()].flatMap((c) =>
    c.rows.map((row) => ({ row, cohort: c, target: targets.get(c)! })),
  );
  const live = new Map(
    (
      await prisma.resource.findMany({
        where: { id: { in: cohortRows.map((r) => r.row.id) } },
        select: { id: true, topic: true },
      })
    ).map((r) => [r.id, r.topic]),
  );

  const moved: Moved[] = [];
  const skipped: Skipped[] = [];
  for (const { row, cohort, target } of cohortRows) {
    const liveTopic = live.get(row.id);
    if (liveTopic !== row.currentTopic) {
      skipped.push({
        id: row.id,
        title: row.title,
        reason: 'live-drift',
        detail: `recorded ${row.currentTopic}, live ${liveTopic ?? '(row gone)'}`,
      });
      continue;
    }
    const decision = decideRefile(row, target);
    if (typeof decision === 'string') {
      skipped.push({ id: row.id, title: row.title, reason: decision, detail: target });
      continue;
    }
    if (apply) await applyReclassification(row.id, decision);
    moved.push({ id: row.id, title: row.title, from: row.currentTopic, to: target, label: cohort.label });
  }

  console.log(`rows ${apply ? 'refiled' : 'that would be refiled'}: ${moved.length}`);
  if (skipped.length > 0) {
    console.log(`rows skipped: ${skipped.length}`);
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`  ${reason.padEnd(14)} ${n}`);
    for (const s of skipped.slice(0, 10)) console.log(`    ${s.reason}: ${s.detail}  ${s.title.slice(0, 50)}`);
  }
  console.log('');

  // ── phase 2: settle ─────────────────────────────────────────────────────────
  //
  // Now, and only now, is there a shelf to measure against. Every moved row is re-read
  // against the refiled library: does its new topic actually hold its 10-neighbourhood?
  //
  // Report it honestly whichever way it comes out. The thin cohorts are EXPECTED to stay
  // contested — a 14-row topic embedded inside a 200-row adjacent one cannot hold a
  // plurality in a 10-neighbour window (As-built T4a item 7) — and that is a T4e input,
  // not something to tune this pass toward hiding.
  type Settled = Moved & { relevance: number; contested: boolean };
  let settled: Settled[] = [];
  if (!apply) {
    console.log('settle phase skipped: nothing moved in a dry run.\n');
  } else if (moved.length > 0) {
    settled = await mapPool(moved, async (m) => {
      const neighbourTopics = await knnNeighbourTopicsOf(m.id);
      const s = decideSettlement(
        m.to,
        { purity: purity(neighbourTopics, m.to), plurality: plurality(neighbourTopics) },
        neighbourTopics.length,
      );
      await settleMembership(m.id, m.to, s);
      return { ...m, ...s };
    });

    console.log('settlement — does the refiled shelf now hold its own rows?');
    console.log('  topic                             rows  vouched  mean relevance');
    const byTopic = new Map<string, Settled[]>();
    for (const s of settled) byTopic.set(s.to, [...(byTopic.get(s.to) ?? []), s]);
    for (const [topic, rows] of [...byTopic].sort((a, b) => b[1].length - a[1].length)) {
      const vouched = rows.filter((r) => !r.contested).length;
      const mean = rows.reduce((n, r) => n + r.relevance, 0) / rows.length;
      console.log(
        `  ${topic.padEnd(32)} ${String(rows.length).padStart(4)}  ` +
          `${String(vouched).padStart(4)}/${String(rows.length).padEnd(4)} ${mean.toFixed(2)}`,
      );
    }
    console.log('');
  }

  // ── closing measurements ────────────────────────────────────────────────────
  const pools = await topicPools();
  console.log('pool sizes for the refiled shelves:');
  for (const topic of new Set(moved.map((m) => m.to))) {
    const n = pools.get(topic) ?? 0;
    console.log(`  ${topic.padEnd(32)} ${String(n).padStart(4)}${n >= QUORUM ? '  ← vouchable' : '  ← STILL BELOW THE BAR'}`);
  }

  // T4d's precondition. T4a wrote 58 secondaries, ALL contested — i.e. none that widen
  // reachability, which is why As-built T4a item 3 pinned the narrowing to this block.
  // Every row this pass moves converts its vacated primary into one of these.
  const [{ c: uncontested }] = await prisma.$queryRaw<{ c: number }[]>`
    SELECT count(*)::int AS c FROM "ResourceTopic"
    WHERE NOT "isPrimary" AND NOT contested
  `;
  console.log(`\nuncontested secondaries (T4d's precondition): ${uncontested}`);

  const out = arg('out');
  if (out) {
    await writeFile(
      out,
      JSON.stringify(
        {
          runAt: new Date().toISOString(),
          source: from,
          applied: apply,
          quorum: QUORUM,
          clears: slate.clears.map((c) => ({ channel: c.channel, label: c.label, rows: c.rows.length })),
          below: slate.below.map((c) => ({ channel: c.channel, label: c.label, rows: c.rows.length })),
          moved: settled.length > 0 ? settled : moved,
          skipped,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`wrote the move record to ${out}`);
  }

  console.log('');
  await assertMembershipInvariants();
  console.log('\ninvariants OK');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
