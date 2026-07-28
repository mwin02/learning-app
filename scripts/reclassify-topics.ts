// Topic filing T4a — bulk reclassification of the backlog that was never classified.
//
// 1,152 of 1,926 rows live under a topic with no TOPIC_RELATIONS edges, and pre-T2b the
// classifier was skipped whenever `relatedTopics(requestTopic)` had one member — so those
// rows carry `origin: inherited, relevance: 1.0`, which means "unknown", not "certain".
// This driver re-runs the open-vocabulary classifier over them and writes what the T2b
// guardrail vouches for. The decision matrix is pure and lives (with its tests) in
// src/lib/curation/reclassify.ts; this is the operator surface.
//
// ⚠️ It NEVER refiles. See that module's header for why (detection works, correction does
// not). Disagreements are recorded as doubt on the membership; `Resource.status` is
// never touched, because those rows already passed human QUALITY review and some are
// attached to live Paths. Minting the topics this pass discovers we lack is T4b, quorum-
// gated, fed by the `newTopic` tally printed at the end of every run.
//
// Run:
//   npx tsx --env-file=.env.local scripts/reclassify-topics.ts              # dry run
//   npx tsx --env-file=.env.local scripts/reclassify-topics.ts --apply
//   npx tsx --env-file=.env.local scripts/reclassify-topics.ts --topics=sql,python --limit=50
//   npx tsx --env-file=.env.local scripts/reclassify-topics.ts --all --apply # incl. the ~774
//
// ⚠️ Stop the compose workers first (`docker compose --profile workers stop worker`) —
// this rewrites memberships under topics a live sourcing run may be filing into.

import { writeFile } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { relatedTopics } from '../src/types/resource';
import { listCanonicals } from '../src/lib/agents/topic-registry';
import { classifyDiscoveryTopics } from '../src/lib/agents/tools/classify-topic';
import { knnNeighbourTopicsOf, topicPools } from '../src/lib/curation/topic-knn';
import { centroidMargins } from '../src/lib/curation/topic-centroids';
import {
  applyReclassification,
  assertMembershipInvariants,
} from '../src/lib/curation/resource-topics';
import {
  decideReclassification,
  tallyQuorumChannels,
  type ReclassifyDecision,
} from '../src/lib/curation/reclassify';

// T4b's bar, printed here so a dry-run says which shelves are ready to seed. Below it,
// k-NN can never vouch for the topic, so filing a handful of rows there would strand
// them on a shelf the guardrail permanently distrusts.
const QUORUM = 10;

// One classifier call per batch. Kept small: the prompt carries each row's full metadata
// and the whole canonical vocabulary, and a structured-output failure costs the batch.
const BATCH = 10;

// Batches in flight. The work is latency-bound on the classifier call, not CPU- or
// DB-bound; 4 keeps a comfortable margin under Vertex rate limits while turning a
// ~90-minute serial run into ~20 minutes. See the safety argument at the loop.
const CONCURRENCY = 4;

type Row = {
  id: string;
  topic: string;
  url: string;
  title: string;
  summary: string;
  conceptsTaught: string[];
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

// The default backlog: every topic in the library that has NO relations. That is exactly
// the population where `relatedTopics(topic).length === 1` made the pre-T2b classifier a
// no-op, and it is derived rather than hardcoded so it stays correct if an edge is added.
async function defaultBacklogTopics(): Promise<string[]> {
  const rows = await prisma.resource.groupBy({ by: ['topic'] });
  return rows.map((r) => r.topic).filter((t) => relatedTopics(t).length === 1);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');
  // Re-scored rows stop being `inherited`, so the default selector doubles as the resume
  // point: a run that dies at row 700 of 1,152 picks up where it left off instead of
  // re-paying for the first 700. `--force` re-scores rows that already have a verdict.
  const force = process.argv.includes('--force');
  const limit = Number(arg('limit')) || undefined;
  const explicit = arg('topics')?.split(',').map((t) => t.trim()).filter(Boolean);

  // An empty list would make `Prisma.join` throw; `--all` and "no backlog left" are both
  // legitimately "no topic filter", handled as undefined.
  const selected = explicit?.length ? explicit : all ? undefined : await defaultBacklogTopics();
  const topics = selected?.length ? selected : undefined;
  if (!all && !topics) {
    console.log('no backlog topics found — nothing to do.\n');
    await assertMembershipInvariants();
    return;
  }
  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`topics: ${topics ? topics.join(', ') : 'ALL'}`);
  console.log(`selector: ${force ? 'every row' : 'rows whose primary is still `inherited`'}\n`);

  // Composed rather than interpolated: an unfiltered run and a `--topics` run are
  // different SQL, and `LIMIT` is optional. `Prisma.empty` keeps the parameterization.
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT r.id, r.topic, r.url, r.title, r.summary, r."conceptsTaught"
    FROM "Resource" r
    JOIN "ResourceTopic" rt ON rt."resourceId" = r.id AND rt."isPrimary"
    WHERE r.embedding IS NOT NULL
      ${topics ? Prisma.sql`AND r.topic IN (${Prisma.join(topics)})` : Prisma.empty}
      ${force ? Prisma.empty : Prisma.sql`AND rt.origin::text = 'inherited'`}
    ORDER BY r.topic, r.id
    ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}
  `);

  console.log(`rows to reclassify: ${rows.length}\n`);
  if (rows.length === 0) {
    await report([], apply);
    return;
  }

  const vocabulary = await listCanonicals();
  // Snapshotted ONCE for the whole run. Pools grow as this pass writes secondaries, so
  // reading them per batch would make a row's `unvouchable-pool` verdict depend on where
  // it landed in the run order — the same order-dependence T2b's batch snapshot fixed at
  // discovery time, and worse here across 1,152 rows.
  const pools = await topicPools();
  console.log(`vocabulary: ${vocabulary.length} canonicals; pools: ${pools.size} topics\n`);

  // Batched BY TOPIC: `classifyDiscoveryTopics` takes one fallback topic per call, and
  // the fallback has to be the row's own current topic for its "none of these fit"
  // answer to mean anything.
  const byTopic = new Map<string, Row[]>();
  for (const r of rows) {
    const bucket = byTopic.get(r.topic) ?? [];
    bucket.push(r);
    byTopic.set(r.topic, bucket);
  }

  const batches: { topic: string; rows: Row[] }[] = [];
  for (const [topic, group] of byTopic) {
    for (let i = 0; i < group.length; i += BATCH) {
      batches.push({ topic, rows: group.slice(i, i + BATCH) });
    }
  }

  // ⚠️ Batches run CONCURRENTLY, which is only sound because this pass never refiles.
  // A decision reads three things: the pool snapshot (taken once, above), the neighbours'
  // labels, and the row's own memberships. Neighbour labels are `Resource.topic`, and
  // the never-refile invariant means no batch can change any row's `Resource.topic` — so
  // no batch can alter the evidence another batch reads. That is the property T2b had to
  // buy with a pre-insert snapshot at discovery time; here it holds by construction.
  // (Serially, measured 2026-07-27, the full backlog took ~90 minutes — the classifier
  // call is the whole cost and it is almost all latency.)
  const decisions: (ReclassifyDecision & { row: Row })[] = [];
  let cursor = 0;
  let processed = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < batches.length) {
      const { topic, rows: batch } = batches[cursor++];
      const proposals = await classifyDiscoveryTopics(
        batch.map((r) => ({
          url: r.url,
          title: r.title,
          summary: r.summary,
          conceptsTaught: r.conceptsTaught,
        })),
        vocabulary,
        topic,
      );
      const margins = await centroidMargins(batch.map((r) => r.id));

      // Per-row evidence in parallel: two independent indexed reads per row, and 10
      // sequential round-trips per batch is real time against a remote DB.
      const evidence = await Promise.all(
        batch.map(async (row) => ({
          row,
          existing: await prisma.resourceTopic.findMany({
            where: { resourceId: row.id },
            select: { topic: true },
          }),
          // Leave-one-out explicitly: the row is already in the table, so without the
          // `n.id <> r.id` in that query it would be its own nearest neighbour at
          // distance 0 and vote for itself.
          neighbourTopics: await knnNeighbourTopicsOf(row.id),
        })),
      );

      for (const { row, existing, neighbourTopics } of evidence) {
        const proposal = proposals.get(row.url);
        const decision = decideReclassification({
          currentTopic: row.topic,
          proposals: proposal?.topics ?? [],
          newTopic: proposal?.newTopic ?? null,
          neighbourTopics,
          pools,
          existingTopics: existing.map((e) => e.topic),
          margin: margins.get(row.id)?.margin ?? null,
        });
        decisions.push({ ...decision, row });
        // Writes touch only this row, and setPrimaryTopic takes a row lock, so a
        // concurrent batch cannot interleave with it.
        if (apply) await applyReclassification(row.id, decision);
      }

      processed += batch.length;
      process.stdout.write(`  ${processed}/${rows.length}\r`);
    }
  };
  await Promise.all([...Array(CONCURRENCY)].map(() => runNext()));
  process.stdout.write('\n');

  await report(decisions, apply);
}

async function report(
  decisions: (ReclassifyDecision & { row: Row })[],
  apply: boolean,
): Promise<void> {
  const counts = new Map<string, number>();
  for (const d of decisions) counts.set(d.verdict, (counts.get(d.verdict) ?? 0) + 1);

  console.log('\nverdicts:');
  for (const v of ['agree', 'disagree', 'unvouchable-pool', 'no-evidence']) {
    const n = counts.get(v) ?? 0;
    const pct = decisions.length ? ((n / decisions.length) * 100).toFixed(1) : '0.0';
    console.log(`  ${v.padEnd(18)} ${String(n).padStart(5)}  ${pct}%`);
  }

  const newMemberships = decisions.reduce((n, d) => n + d.secondaries.length, 0);
  const uncontested = decisions.reduce(
    (n, d) => n + d.secondaries.filter((s) => !s.contested).length,
    0,
  );
  console.log(
    `\nsecondary memberships ${apply ? 'written' : 'that would be written'}: ${newMemberships}` +
      `  (${uncontested} uncontested — these are what make cross-topic retrieval real,` +
      ` and T4d's narrowing depends on them)`,
  );

  // The contested list. The review surface is a separate block, so this stdout table is
  // the interim reviewer input — sorted by margin, most suspicious first, since a row the
  // centroid margin ALSO doubts is the strongest signal we have. `evidence` is the
  // neighbourhood's plurality, which is the only context available on a rejected
  // proposal (where there is no alternative membership to point at).
  // Nulls sort LAST, not as zero: "no centroid to compare against" (a topic under
  // MIN_CENTROID_MEMBERS) is absence of a reading, and mixing it into the middle of the
  // ranking would bury the rows whose margin genuinely says something.
  const contested = decisions
    .filter((d) => d.primary?.contested)
    .sort((a, b) => (a.margin ?? Infinity) - (b.margin ?? Infinity));
  if (contested.length > 0) {
    console.log(`\ncontested primaries (${contested.length}) — worst margin first:`);
    console.log('  margin  current → evidence (purity)  title');
    for (const d of contested.slice(0, 40)) {
      const alt = d.secondaries[0]?.topic ?? d.evidenceTopic ?? '?';
      console.log(
        `  ${(d.margin?.toFixed(3) ?? '  -  ').padStart(6)}  ` +
          `${d.row.topic.padEnd(30)} → ${alt.padEnd(30)} ` +
          `${d.evidencePurity.toFixed(1)}  ${d.row.title.slice(0, 58)}`,
      );
    }
    if (contested.length > 40) console.log(`  … and ${contested.length - 40} more`);
  }

  // T4b's two quorum channels. `mint` needs the topic gate to produce a slug first;
  // `seed` already has the slug and only lacks a pool. Both are answered by refiling the
  // whole cohort at once so the shelf clears MIN_VOUCHABLE_POOL immediately.
  const { mint, seed } = tallyQuorumChannels(decisions);
  for (const [channel, tally] of [
    ['seed (existing canonical, empty shelf)', seed],
    ['mint (subject missing from the vocabulary)', mint],
  ] as const) {
    const rows = [...tally].sort((a, b) => b[1] - a[1]);
    if (rows.length === 0) continue;
    console.log(`\nT4b ${channel}:`);
    for (const [label, n] of rows.slice(0, 25)) {
      const ready = n >= QUORUM ? '  ← clears quorum' : '';
      console.log(`  ${String(n).padStart(4)}  ${label}${ready}`);
    }
  }

  // The full record, for the review surface (a separate block) and for T4b's seed/mint
  // passes — stdout truncates the contested table at 40 of what is typically 130+ rows.
  const out = arg('out');
  if (out) {
    await writeFile(
      out,
      JSON.stringify(
        {
          runAt: new Date().toISOString(),
          applied: apply,
          verdicts: Object.fromEntries(counts),
          rows: decisions.map((d) => ({
            id: d.row.id,
            url: d.row.url,
            title: d.row.title,
            currentTopic: d.row.topic,
            verdict: d.verdict,
            contested: d.primary?.contested ?? false,
            relevance: d.primary?.relevance ?? null,
            evidenceTopic: d.evidenceTopic,
            evidencePurity: d.evidencePurity,
            margin: d.margin,
            secondaries: d.secondaries,
            newTopic: d.newTopic,
            unvouchable: d.unvouchable,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\nwrote ${decisions.length} decisions to ${out}`);
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
