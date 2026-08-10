// Topic filing T1 — backfill one primary ResourceTopic membership per existing Resource
// from the legacy scalar `Resource.topic`.
//
// A driver, not an in-migration step (topic-filing.md, "Backfill"): 1,926 rows
// is fine either way, but the free-beta D2 Supabase cutover re-runs table lists and a
// driver is re-runnable where a migration is not.
//
// This is the ONE writer allowed to bypass the setPrimaryTopic seam. The seam exists to
// keep `Resource.topic` and `ResourceTopic.isPrimary` in step when a resource is REFILED;
// this backfill derives memberships FROM the mirror and changes no topic, so there is
// nothing to rot — and a per-row transaction would buy ~1,900 round-trips to a remote DB
// for an invariant it cannot violate.
//
// Idempotent by construction: it inserts only for resources that have NO membership at
// all. A re-run after T2/T3 have written real memberships is a no-op over those rows
// rather than a fight with them.
//
// Run:  npx tsx --env-file=.env.local scripts/backfill-resource-topics.ts [--apply]

import { prisma } from '../src/lib/db';
import { assertMembershipInvariants } from '../src/lib/curation/resource-topics';

type Count = { c: number };

async function main() {
  const apply = process.argv.includes('--apply');

  const [{ c: resources }] = await prisma.$queryRaw<Count[]>`
    SELECT count(*)::int AS c FROM "Resource"
  `;
  const [{ c: missing }] = await prisma.$queryRaw<Count[]>`
    SELECT count(*)::int AS c FROM "Resource" r
    WHERE NOT EXISTS (SELECT 1 FROM "ResourceTopic" rt WHERE rt."resourceId" = r.id)
  `;
  console.log(
    `resources: ${resources}  without any membership: ${missing}  ` +
      `(mode: ${apply ? 'APPLY' : 'dry-run'})`,
  );

  if (apply && missing > 0) {
    // gen_random_uuid()::text stands in for Prisma's client-side cuid(): the column is
    // TEXT and nothing parses these ids, they only have to be unique.
    const inserted = await prisma.$executeRaw`
      INSERT INTO "ResourceTopic" ("id", "resourceId", "topic", "relevance", "origin", "isPrimary", "createdAt")
      SELECT gen_random_uuid()::text, r.id, r.topic, 1.0, 'inherited', true, now()
      FROM "Resource" r
      WHERE NOT EXISTS (SELECT 1 FROM "ResourceTopic" rt WHERE rt."resourceId" = r.id)
      ON CONFLICT ("resourceId", "topic") DO NOTHING
    `;
    console.log(`inserted: ${inserted}`);
  } else if (!apply && missing > 0) {
    const sample = await prisma.$queryRaw<{ topic: string; c: number }[]>`
      SELECT r.topic, count(*)::int AS c FROM "Resource" r
      WHERE NOT EXISTS (SELECT 1 FROM "ResourceTopic" rt WHERE rt."resourceId" = r.id)
      GROUP BY r.topic ORDER BY c DESC
    `;
    console.log('would insert, by topic:');
    for (const row of sample) console.log(`  ${row.topic.padEnd(34)} ${row.c}`);
  }

  // Run in both modes: in dry-run these report the CURRENT state of the table, which is
  // exactly what you want to see before deciding to apply.
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
