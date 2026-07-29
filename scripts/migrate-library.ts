// Free-beta D2: copy the LIBRARY LAYER from the local dev DB to Supabase.
//
//   SUPABASE_DB_URL='postgresql://…:5432/postgres?sslmode=require' \
//     npx tsx --env-file=.env.local scripts/migrate-library.ts          # dry run
//   SUPABASE_DB_URL='…' npx tsx --env-file=.env.local scripts/migrate-library.ts --yes
//
// The local library is the curated, backfilled, human-reviewed asset; Supabase
// has the schema but no rows. This moves the four tables that constitute the
// library and nothing else — the map/track/program layer is rebuilt by the warm
// campaign (C2), not migrated (docs/free-beta-plan.md).
//
// COPIES: Source, TopicAlias, Resource, ResourceTopic.
//   ResourceTopic is NOT in the plan's original table list (it postdates it, from
//   topic filing T1) but is mandatory: it is where topic membership actually
//   lives, and retrieval's `topic IN (…)` EXISTS subquery reads it. Copying
//   Resource without it yields a library no query can reach.
// NEVER TOUCHES: User (real accounts live on the target), Progress, ratings, and
//   the whole Path/Concept/Track/Program layer.
// DELIBERATELY NOT COPIED:
//   - `Resource.embedding` — pgvector, Prisma-`Unsupported`, unreadable through
//     the client. Re-derive on the target: `scripts/embed-resources.ts`.
//   - `TopicCentroid` — pgvector too, and purely derived; embed-resources.ts
//     calls refreshTopicCentroids() as its last step, so it regenerates for free.
//   - `ResourceSourcedFor` — Concept-anchored (FK → Concept, onDelete: Cascade);
//     it has nothing to attach to on a map-less target, and warm builds
//     regenerate provenance.
//
// IDS ARE PRESERVED. Copying `id` verbatim is what makes this simple and
// re-runnable: `sourceId`, `parentResourceId` and `ResourceTopic.resourceId`
// become straight copies with no remapping table, and every write is an upsert
// keyed on the primary key. The preflight refuses to run if the target holds a
// row with a matching natural key (slug/url/alias) under a DIFFERENT id — that
// is the only case where id-preservation would silently fork a row, and it
// cannot be resolved automatically.
//
// Conflict policy is LOCAL WINS (plan-locked). With ids preserved that falls out
// of upsert-by-id; the preflight is what keeps it honest.
//
// Use the Supabase DIRECT connection (port 5432), not the transaction pooler
// (6543): pgbouncer in transaction mode breaks the batched multi-statement
// transactions below.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { prisma as source } from '../src/lib/db';

// The one place in the codebase with two Prisma clients: this script is a
// cross-database copy, so the `@/lib/db` singleton (the SOURCE, on DATABASE_URL)
// cannot also be the target. Mirrors db.ts's libpq-compat handling — recent
// node-postgres reads `sslmode=require` as `verify-full`, which rejects
// Supabase's chain.
function makeTargetClient(raw: string): PrismaClient {
  const url = new URL(raw);
  if (!url.searchParams.has('uselibpqcompat')) url.searchParams.set('uselibpqcompat', 'true');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
}

function describe(raw: string): string {
  const u = new URL(raw);
  return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
}

// Chunked so a batch is one round trip to us-west-1 rather than 2,000 of them.
const BATCH = 100;

async function inBatches<T>(rows: T[], label: string, op: (row: T) => unknown): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await target.$transaction(chunk.map((r) => op(r) as never));
    // Carriage-return progress only on a terminal; piped to a log it would be
    // one unreadable line. Redirected runs get the single summary below.
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
  }
  if (process.stdout.isTTY && rows.length) process.stdout.write('\r');
  console.log(`  ${label}: ${rows.length} row(s)`);
}

const rawTarget = process.env.SUPABASE_DB_URL;
if (!rawTarget) {
  console.error(
    'SUPABASE_DB_URL is not set. Pass the Supabase DIRECT connection string (port 5432).\n' +
      'It is deliberately a separate variable from DATABASE_URL so the copy direction is\n' +
      'unambiguous and cannot be run backwards by editing .env.local.',
  );
  process.exit(1);
}
if (rawTarget === process.env.DATABASE_URL) {
  console.error('SUPABASE_DB_URL equals DATABASE_URL — source and target must differ.');
  process.exit(1);
}
// Not fatal — a non-Supabase target legitimately has other ports — but the
// pooler is the one wrong answer that fails deep into a batch rather than at
// connect time (pgbouncer in transaction mode cannot hold the batched
// transactions below), so it is worth naming before the copy starts.
if (new URL(rawTarget).port === '6543') {
  console.warn(
    '⚠ target port 6543 is the Supabase TRANSACTION POOLER. Batched transactions\n' +
      '  will fail against it — use the DIRECT connection (5432) for this copy.\n',
  );
}
const target = makeTargetClient(rawTarget);

/**
 * Refuses the copy when the target holds a row under a different id than the
 * source's for the same natural key. Empty target ⇒ trivially clean; this exists
 * so a re-run against a target that has since been written to fails loudly
 * instead of forking rows.
 */
async function preflight(): Promise<number> {
  const [srcSources, srcAliases, srcResources] = await Promise.all([
    source.source.findMany({ select: { id: true, slug: true } }),
    source.topicAlias.findMany({ select: { id: true, alias: true } }),
    source.resource.findMany({ select: { id: true, slug: true, url: true } }),
  ]);

  const conflicts: string[] = [];
  const [tgtSources, tgtAliases, tgtResources] = await Promise.all([
    target.source.findMany({ select: { id: true, slug: true } }),
    target.topicAlias.findMany({ select: { id: true, alias: true } }),
    target.resource.findMany({ select: { id: true, slug: true, url: true } }),
  ]);

  const byKey = <T extends { id: string }>(rows: T[], key: (r: T) => string) =>
    new Map(rows.map((r) => [key(r), r.id]));

  const check = <T extends { id: string }>(
    src: T[],
    tgt: T[],
    key: (r: T) => string,
    label: string,
  ) => {
    const tgtIds = byKey(tgt, key);
    for (const row of src) {
      const existing = tgtIds.get(key(row));
      if (existing && existing !== row.id) {
        conflicts.push(`${label} ${key(row)}: local ${row.id} vs target ${existing}`);
      }
    }
  };

  check(srcSources, tgtSources, (r) => r.slug, 'Source.slug');
  check(srcAliases, tgtAliases, (r) => r.alias, 'TopicAlias.alias');
  check(srcResources, tgtResources, (r) => r.slug, 'Resource.slug');
  check(srcResources, tgtResources, (r) => r.url, 'Resource.url');

  if (conflicts.length) {
    console.error(`\n✗ ${conflicts.length} natural-key conflict(s) — the target holds these`);
    console.error('  keys under different ids. Resolve by hand; do not force.\n');
    for (const c of conflicts.slice(0, 20)) console.error('   ', c);
    if (conflicts.length > 20) console.error(`    … and ${conflicts.length - 20} more`);
    process.exit(1);
  }
  return srcResources.length;
}

async function counts(client: PrismaClient) {
  return {
    Source: await client.source.count(),
    TopicAlias: await client.topicAlias.count(),
    Resource: await client.resource.count(),
    ResourceTopic: await client.resourceTopic.count(),
    User: await client.user.count(),
  };
}

async function copy(): Promise<void> {
  const sources = await source.source.findMany();
  await inBatches(sources, 'Source', (row) =>
    target.source.upsert({ where: { id: row.id }, create: row, update: row }),
  );

  const aliases = await source.topicAlias.findMany();
  await inBatches(aliases, 'TopicAlias', (row) =>
    target.topicAlias.upsert({ where: { id: row.id }, create: row, update: row }),
  );

  // Two passes instead of a depth sort. `parentResourceId` is a self-FK, so a
  // child inserted before its parent fails; nulling the link on the way in makes
  // insertion order irrelevant, and pass 2 restores the tree. This also sidesteps
  // @@unique([parentResourceId, orderInParent]) — NULLs compare distinct in
  // Postgres, so pass 1 can never collide on it.
  //
  // `embedding` is absent from findMany's result by construction (Prisma cannot
  // select an Unsupported column), and `embeddedAt` is forced null on CREATE so
  // embed-resources.ts treats every copied row as stale. On UPDATE it is left
  // alone, so re-running this script does not invalidate work the backfill has
  // already done on the target.
  const resources = await source.resource.findMany();
  await inBatches(resources, 'Resource (pass 1: rows)', (row) => {
    // `undefined` is Prisma's "leave this column alone" on UPDATE — the tree is
    // pass 2's job, and `embeddedAt` belongs to whatever re-embedding has
    // already happened on the target. On CREATE they start explicitly null.
    return target.resource.upsert({
      where: { id: row.id },
      create: { ...row, parentResourceId: null, orderInParent: null, embeddedAt: null },
      update: {
        ...row,
        parentResourceId: undefined,
        orderInParent: undefined,
        embeddedAt: undefined,
      },
    });
  });

  const children = resources.filter((r) => r.parentResourceId !== null);
  await inBatches(children, 'Resource (pass 2: tree)', (row) =>
    target.resource.update({
      where: { id: row.id },
      data: { parentResourceId: row.parentResourceId, orderInParent: row.orderInParent },
    }),
  );

  const memberships = await source.resourceTopic.findMany();
  await inBatches(memberships, 'ResourceTopic', (row) =>
    target.resourceTopic.upsert({ where: { id: row.id }, create: row, update: row }),
  );
}

/** Per-topic membership counts, so a silent partial copy can't pass as success. */
async function topicDiff(): Promise<{ topic: string; local: number; target: number }[]> {
  const group = (client: PrismaClient) =>
    client.resourceTopic.groupBy({ by: ['topic'], _count: { _all: true } });
  const [src, tgt] = await Promise.all([group(source), group(target)]);
  const tgtMap = new Map(tgt.map((r) => [r.topic, r._count._all]));
  return src
    .map((r) => ({ topic: r.topic, local: r._count._all, target: tgtMap.get(r.topic) ?? 0 }))
    .filter((r) => r.local !== r.target)
    .sort((a, b) => b.local - a.local);
}

/** Deepest local decomposition tree, compared child-for-child on the target. */
async function treeSpotCheck(): Promise<void> {
  const parent = await source.resource.findFirst({
    where: { decompositionStatus: 'decomposed', children: { some: {} } },
    orderBy: { children: { _count: 'desc' } },
    select: { id: true, title: true },
  });
  if (!parent) {
    console.log('  (no decomposed containers locally — nothing to spot-check)');
    return;
  }
  const pick = { where: { parentResourceId: parent.id }, orderBy: { orderInParent: 'asc' } } as const;
  const [local, remote] = await Promise.all([
    source.resource.findMany({ ...pick, select: { id: true, orderInParent: true } }),
    target.resource.findMany({ ...pick, select: { id: true, orderInParent: true } }),
  ]);
  const same =
    local.length === remote.length &&
    local.every((c, i) => c.id === remote[i].id && c.orderInParent === remote[i].orderInParent);
  console.log(
    `  ${same ? '✓' : '✗'} tree "${parent.title.slice(0, 60)}": ` +
      `${local.length} children local / ${remote.length} target, order ${same ? 'intact' : 'MISMATCH'}`,
  );
}

async function main() {
  const apply = process.argv.includes('--yes');
  console.log(`\n=== library migration (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  console.log(`  source: ${describe(process.env.DATABASE_URL!)}`);
  console.log(`  target: ${describe(rawTarget!)}\n`);

  const total = await preflight();
  console.log('✓ preflight: no natural-key conflicts\n');

  console.log('before:');
  console.table({ local: await counts(source), target: await counts(target) });

  if (!apply) {
    console.log(`\nDry run only. Re-run with --yes to copy ${total} resources (+ their`);
    console.log('memberships, sources and aliases) into the target.\n');
    return;
  }

  await copy();

  console.log('\nafter:');
  console.table({ local: await counts(source), target: await counts(target) });

  const drift = await topicDiff();
  if (drift.length) {
    console.log('\n✗ per-topic membership counts differ:');
    console.table(drift);
  } else {
    console.log('\n✓ per-topic membership counts match across every topic');
  }
  await treeSpotCheck();

  console.log('\nNext: re-embed on the target (embeddings were deliberately not copied):');
  console.log('  DATABASE_URL="$SUPABASE_DB_URL" npx tsx scripts/embed-resources.ts\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await source.$disconnect();
    await target.$disconnect();
  });
