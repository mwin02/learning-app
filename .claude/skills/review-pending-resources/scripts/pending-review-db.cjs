// DB helper for the review-pending-resources skill. Run from the repo root with
// the app's env so it reuses the same Prisma + pg-adapter setup as src/lib/db.ts:
//   node --env-file=.env.local .claude/skills/review-pending-resources/scripts/pending-review-db.cjs <cmd> ...
//
// Against PRODUCTION (post-cutover the review queue lives on Supabase), override
// DATABASE_URL inline — shell env beats --env-file, and .env.local stays local:
//   DATABASE_URL="$SUPABASE_POOLER_URL" node --env-file=.env.local <this script> ...
// Use SUPABASE_POOLER_URL (the :6543 transaction pooler), NOT SUPABASE_DB_URL:
// that one is the direct :5432 endpoint, which is IPv6-only on current Supabase
// projects. It happens to work from a laptop with IPv6, which is exactly what
// makes it a trap to standardise on — it fails from anything IPv4-only, and it is
// the migration connection, not the runtime one.
// Every run prints the database it connected to; check it before trusting an
// empty queue.
//
//   sample <rootId> [n]  → for a container root, the subtree size and a spread of
//                          up to n atomic LEAF resources to spot-check in the
//                          browser. The GET API only returns a root's *direct*
//                          children; for multi-level containers the real pickable
//                          leaves are deeper, so sample them here.
//   state <id> [id ...]  → status / deprecationSeverity / decompositionStatus for
//                          one or more ids — verify a decision landed.
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL);
if (!url.searchParams.has('uselibpqcompat')) url.searchParams.set('uselibpqcompat', 'true');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });

// Always announce the target. The review queue this drains lives on Supabase in
// production but on the local Docker Postgres by default, and the failure mode
// is silent: pointed at the wrong one it reports an empty queue rather than an
// error, which reads as "nothing to review" instead of "wrong database".
console.error(`[db] ${url.hostname}:${url.port || '5432'}${url.pathname}`);

const [cmd, ...rest] = process.argv.slice(2);

async function subtreeAtomicLeaves(rootId) {
  // All atomic (pickable) leaves anywhere in the decomposition subtree.
  return prisma.$queryRaw`
    WITH RECURSIVE s AS (
      SELECT id FROM "Resource" WHERE id = ${rootId}
      UNION ALL SELECT r.id FROM "Resource" r JOIN s ON r."parentResourceId" = s.id
    )
    SELECT id, title, url FROM "Resource"
    WHERE id IN (SELECT id FROM s) AND "decompositionStatus" = 'atomic'
    ORDER BY id`;
}

(async () => {
  if (cmd === 'sample') {
    const [rootId, nRaw] = rest;
    const n = Math.max(1, Number(nRaw) || 3);
    const leaves = await subtreeAtomicLeaves(rootId);
    // Evenly-spaced spread across the leaves, not just the first n — a dead link
    // is as likely at the end as the start.
    const sample = [];
    if (leaves.length > 0) {
      const step = Math.max(1, Math.floor(leaves.length / n));
      for (let i = 0; i < leaves.length && sample.length < n; i += step) sample.push(leaves[i]);
    }
    console.log(JSON.stringify({ rootId, atomicLeafCount: leaves.length, sample }));
  } else if (cmd === 'state') {
    const rows = await prisma.resource.findMany({
      where: { id: { in: rest } },
      select: { id: true, title: true, status: true, deprecationSeverity: true, decompositionStatus: true },
    });
    console.log(JSON.stringify(rows));
  } else {
    console.error('usage: pending-review-db.cjs <sample <rootId> [n] | state <id ...>>');
    process.exit(1);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
