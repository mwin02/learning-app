// C2 recon — READ-ONLY snapshot of the production state before the warm campaign.
//   npx tsx --env-file=.env.local scripts/verify/c2-recon.ts          # local DATABASE_URL
//   npx tsx --env-file=.env.local scripts/verify/c2-recon.ts --prod   # Supabase pooler
//
// --prod reads SUPABASE_POOLER_URL from the process env (loaded by --env-file) and
// assigns it to DATABASE_URL below, BEFORE @/lib/db is imported. The secret never
// becomes a shell word — no `set -a; . ./.env.local` (which exports every secret
// into the interactive shell, the exact setup behind this repo's real leaks; see
// AGENTS.md "Secrets"). @/lib/db reads DATABASE_URL at module-eval, so its import —
// and everything that pulls it in transitively — MUST stay dynamic, inside main(),
// after the override; a static import would bind to localhost before this runs.

export {}; // module scope — the only static imports are dynamic (inside main), see above

if (process.argv.includes('--prod')) {
  const pooler = process.env.SUPABASE_POOLER_URL;
  if (!pooler) throw new Error('SUPABASE_POOLER_URL is not set (expected in .env.local)');
  process.env.DATABASE_URL = pooler;
}

const WARM = [
  'python', 'python-data-ml', 'javascript', 'javascript-react', 'calculus',
  'linear-algebra', 'machine-learning', 'statistics', 'sql',
  'data-structures-algorithms', 'precalculus', 'physics-mechanics',
];

async function main() {
  const { prisma } = await import('../../src/lib/db');
  const paths = await prisma.path.findMany({ select: { topic: true, status: true, createdAt: true } });
  console.log('--- Paths ---');
  for (const p of paths) console.log(`${p.topic}  ${p.status}  ${p.createdAt.toISOString().slice(0, 10)}`);
  if (paths.length === 0) console.log('(none)');

  console.log('--- Library totals ---');
  const byStatus = await prisma.resource.groupBy({ by: ['status'], _count: true });
  console.log(byStatus.map((r) => `${r.status}:${r._count}`).join('  '));

  console.log('--- Warm-topic filing (ResourceTopic rows on active resources) ---');
  for (const t of WARM) {
    const total = await prisma.resourceTopic.count({ where: { topic: t, resource: { status: 'active' } } });
    const primary = await prisma.resourceTopic.count({
      where: { topic: t, isPrimary: true, resource: { status: 'active' } },
    });
    console.log(`${t.padEnd(28)} total:${String(total).padStart(4)}  primary:${String(primary).padStart(4)}`);
  }

  console.log('--- Non-warm topics holding active rows (reachability check) ---');
  const others = await prisma.resourceTopic.groupBy({
    by: ['topic'],
    where: { topic: { notIn: WARM }, resource: { status: 'active' } },
    _count: true,
    orderBy: { _count: { topic: 'desc' } },
  });
  for (const o of others) console.log(`${o.topic.padEnd(36)} ${o._count}`);

  console.log('--- Queues ---');
  const pending = await prisma.resource.count({ where: { status: 'pending_review' } });
  const decomp = await prisma.resource.groupBy({ by: ['decompositionStatus'], _count: true });
  const courseReq = await prisma.courseRequest.groupBy({ by: ['status'], _count: true });
  const remJobs = await prisma.remediationJob.groupBy({ by: ['state'], _count: true });
  console.log(`pending resources: ${pending}`);
  console.log(`decomposition: ${decomp.map((r) => `${r.decompositionStatus}:${r._count}`).join('  ')}`);
  console.log(`courseRequests: ${courseReq.map((r) => `${r.status}:${r._count}`).join('  ') || '(none)'}`);
  console.log(`remediationJobs: ${remJobs.map((r) => `${r.state}:${r._count}`).join('  ') || '(none)'}`);

  console.log('--- Sources seeded ---');
  console.log(await prisma.source.count());
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
