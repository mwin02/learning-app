// Library quality Q7 — the two backfills that go with the guardrail change.
//
//   npx tsx --env-file=.env.local scripts/repair-membership-holes.ts --onramps
//   ... --onramps --apply
//   npx tsx --env-file=.env.local scripts/repair-membership-holes.ts --rescore=docs/audits/refile-b3-cohorts.json
//   ... --rescore=… --apply
//
// TWO MODES, deliberately in one file: both repair rows that a filing decision left in a
// state Q7 changed the rules for, both are one-shot over a known population, and both end
// on the same invariant assertion.
//
//   --onramps  (P5/B6) fills the membership hole `generateOnRampResource` used to leave.
//              The creation path now writes the membership in the same transaction as the
//              row, so this is only for rows created before that fix. Idempotent.
//   --rescore  (P4) re-measures rows a previous refile settled, under the now pool-aware
//              settlement. Reads a `refile-quorum-topics.ts --out=` record for the row
//              set, so the population is exactly what that pass moved, and re-derives
//              every number live — nothing is copied from the record but the ids.
//
// ⚠️ Stop the compose workers first (`docker compose --profile workers stop worker`): the
// re-score reads k-NN neighbourhoods, and a live filing run moves them under it.

import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/db';
import { requireTargetAck } from './target-guard';
import { knnNeighbourTopicsOf, purity, plurality, topicPools } from '../src/lib/curation/topic-knn';
import { decideSettlement } from '../src/lib/curation/quorum-refile';
import {
  setPrimaryTopic,
  settleMembership,
  checkMembershipInvariants,
  assertMembershipInvariants,
} from '../src/lib/curation/resource-topics';

const CONCURRENCY = 8;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

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

// ── --onramps ────────────────────────────────────────────────────────────────

async function backfillOnRamps(apply: boolean): Promise<void> {
  const holes = await prisma.$queryRaw<{ id: string; topic: string; title: string }[]>`
    SELECT r.id, r.topic, r.title
    FROM "Resource" r
    WHERE r.origin::text = 'generated'
      AND NOT EXISTS (SELECT 1 FROM "ResourceTopic" rt WHERE rt."resourceId" = r.id)
    ORDER BY r.topic, r.title
  `;
  console.log(`generated rows with a topic and no membership: ${holes.length}`);
  for (const h of holes) console.log(`  ${h.topic.padEnd(24)} ${h.title.slice(0, 60)}`);

  // The same question for every OTHER writer: is this hole peculiar to the on-ramp path,
  // or does the library have it elsewhere? Reported either way — a non-zero row here means
  // Q7 fixed one creator and missed another.
  const others = await prisma.$queryRaw<{ origin: string; c: number }[]>`
    SELECT r.origin::text AS origin, count(*)::int AS c
    FROM "Resource" r
    WHERE r.origin::text <> 'generated'
      AND NOT EXISTS (SELECT 1 FROM "ResourceTopic" rt WHERE rt."resourceId" = r.id)
    GROUP BY 1
  `;
  console.log(
    others.length === 0
      ? '\nno other writer has the same hole (whole-table).'
      : `\n⚠️ OTHER WRITERS WITH THE SAME HOLE: ${others.map((o) => `${o.origin}=${o.c}`).join(', ')}`,
  );

  if (!apply || holes.length === 0) {
    console.log(`\n${apply ? 'nothing to backfill.' : 'dry run — no writes.'}`);
    return;
  }

  // Through the seam, one row at a time: `setPrimaryTopic` is the only path allowed to
  // touch `isPrimary` and the mirror together, and it is what the creation path now calls.
  // `relevance: 1` is true by construction for an authored lesson (the topic is not a
  // measurement), and `discovery` is the origin for "the request topic, no classifier".
  for (const h of holes) {
    await setPrimaryTopic(h.id, h.topic, { relevance: 1, origin: 'discovery' });
  }
  console.log(`\nbackfilled ${holes.length} membership rows.`);
}

// ── --rescore ────────────────────────────────────────────────────────────────

type MoveRecord = { id: string; to: string; contested?: boolean };

async function rescore(from: string, apply: boolean): Promise<void> {
  const record = JSON.parse(await readFile(from, 'utf8')) as { runAt: string; moved: MoveRecord[] };
  console.log(`record: ${from} (${record.moved.length} rows moved ${record.runAt})`);

  // The live membership is the before-state, not the record's — the record is a snapshot
  // and something may have touched a row since. Rows whose membership is gone are reported,
  // never silently dropped.
  const live = await prisma.resourceTopic.findMany({
    where: { OR: record.moved.map((m) => ({ resourceId: m.id, topic: m.to })) },
    select: { resourceId: true, topic: true, contested: true },
  });
  const byId = new Map(live.map((m) => [`${m.resourceId}:${m.topic}`, m]));
  const missing = record.moved.filter((m) => !byId.has(`${m.id}:${m.to}`));
  const before = live.filter((m) => m.contested).length;
  console.log(`live memberships found: ${live.length}  (missing: ${missing.length})`);
  console.log(`contested BEFORE: ${before}/${live.length}`);

  const pools = await topicPools();
  const results = await mapPool(live, async (m) => {
    const neighbourTopics = await knnNeighbourTopicsOf(m.resourceId);
    const settlement = decideSettlement(
      m.topic,
      { purity: purity(neighbourTopics, m.topic), plurality: plurality(neighbourTopics) },
      neighbourTopics.length,
      pools,
    );
    if (apply) await settleMembership(m.resourceId, m.topic, settlement);
    return { topic: m.topic, was: m.contested, now: settlement.contested };
  });

  const after = results.filter((r) => r.now).length;
  console.log(`contested AFTER:  ${after}/${results.length}${apply ? '' : ' (dry run — not written)'}\n`);

  console.log('  shelf                             pool  rows  contested before → after');
  const byTopic = new Map<string, typeof results>();
  for (const r of results) byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r]);
  for (const [topic, rows] of [...byTopic].sort((a, b) => b[1].length - a[1].length)) {
    console.log(
      `  ${topic.padEnd(32)} ${String(pools.get(topic) ?? 0).padStart(5)} ${String(rows.length).padStart(5)}` +
        `  ${String(rows.filter((r) => r.was).length).padStart(9)} → ${rows.filter((r) => r.now).length}`,
    );
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const onramps = process.argv.includes('--onramps');
  const from = arg('rescore');
  if (!onramps && !from) throw new Error('pass --onramps and/or --rescore=<refile record>');

  // Both modes write live curation state (memberships, contested flags) — the same class
  // of damage the shared guard exists for, and neither is a truncate.
  requireTargetAck('repair-membership-holes', apply, 'REPAIR');
  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}\n`);

  if (onramps) await backfillOnRamps(apply);
  if (onramps && from) console.log('');
  if (from) await rescore(from, apply);

  console.log('');
  // Whole-table, and it now covers the generated population this script repairs. A dry
  // run reports rather than throws: the hole it is about to fix is the whole point.
  if (apply) {
    await assertMembershipInvariants();
    console.log('\ninvariants OK');
  } else {
    console.log(JSON.stringify(await checkMembershipInvariants()));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
