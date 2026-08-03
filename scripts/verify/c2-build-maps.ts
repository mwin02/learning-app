// C2 stage A — build spines only (ensurePathMap, no remediation) for the warm
// set, so scripts/rung0-coverage.ts can measure per-topic library coverage
// BEFORE the web-sourcing spend. warm-paths.ts then runs remediation on top.
//   npx tsx --env-file=.env.local scripts/verify/c2-build-maps.ts          # local DATABASE_URL
//   npx tsx --env-file=.env.local scripts/verify/c2-build-maps.ts --prod   # Supabase pooler
//
// THIS SCRIPT WRITES (ensurePathMap persists Concepts/edges/links), so the target
// is opt-in: without --prod it runs against .env.local's DATABASE_URL (localhost),
// never production by accident. --prod reads SUPABASE_POOLER_URL from the process
// env (loaded by --env-file) and assigns it to DATABASE_URL below, BEFORE @/lib/db
// is imported — no `set -a; . ./.env.local` (which exports every secret into the
// shell, the setup behind this repo's real leaks; see AGENTS.md "Secrets"). @/lib/db
// reads DATABASE_URL at module-eval, so the src/ imports MUST stay dynamic, inside
// main() after the override; a static import would bind to localhost before it runs.

export {}; // module scope — the only src/ imports are dynamic (inside main), see above

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
  const { ensurePathMap } = await import('../../src/lib/agents/map/ensure-path-map');
  const topics = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const topic of topics.length > 0 ? topics : WARM) {
    const t0 = Date.now();
    try {
      await ensurePathMap({ topic });
      const path = await prisma.path.findUnique({ where: { topic }, select: { status: true } });
      const spine = await prisma.concept.count({ where: { path: { topic }, membership: 'spine' } });
      console.log(`${topic.padEnd(28)} ${String(path?.status).padEnd(12)} spine:${spine}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      // PathMapError wraps the real reason as `cause`; printing only `message`
      // loses it, which is what made the first statistics failure unreadable.
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause : undefined;
      console.log(`${topic.padEnd(28)} FAILED  ${e instanceof Error ? e.message : e}`);
      if (cause) console.log(`    cause: ${cause.message}\n${cause.stack?.split('\n').slice(1, 4).join('\n')}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
