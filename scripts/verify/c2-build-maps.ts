// C2 stage A — build spines only (ensurePathMap, no remediation) for the warm
// set, so scripts/rung0-coverage.ts can measure per-topic library coverage
// BEFORE the web-sourcing spend. warm-paths.ts then runs remediation on top.
//   set -a; . ./.env.local; set +a
//   DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx scripts/verify/c2-build-maps.ts
import { prisma } from '../../src/lib/db';
import { ensurePathMap } from '../../src/lib/agents/map/ensure-path-map';

const WARM = [
  'python', 'python-data-ml', 'javascript', 'javascript-react', 'calculus',
  'linear-algebra', 'machine-learning', 'statistics', 'sql',
  'data-structures-algorithms', 'precalculus', 'physics-mechanics',
];

async function main() {
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
