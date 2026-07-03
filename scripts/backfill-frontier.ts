// Frontier backfill: run the frontier enrichment pass (ensureFrontier) over
// existing Paths. The 2026-07-02 audit found every production map 100% spine —
// this tops them up in place. Strictly ADDITIVE: never rebuilds a map (the
// existing Concepts have Tracks over them), and ensureFrontier's own guard
// skips any map that already has frontier, so re-running is safe.
//
//   npx tsx --env-file=.env.local scripts/backfill-frontier.ts             # all Paths
//   npx tsx --env-file=.env.local scripts/backfill-frontier.ts --dry-run   # list only
//   npx tsx --env-file=.env.local scripts/backfill-frontier.ts <topic|pathId> ...
//
// Sequential on purpose: each pass is one author call + per-concept attach +
// up to FRONTIER_MAX_WEB_SOURCED sourcing ladders (~3–5 min/map), and running
// maps in parallel would multiply concurrent Vertex/search load for no urgency.

import { ConceptMembership } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { ensureFrontier } from '../src/lib/agents/map/ensure-frontier';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targets = args.filter((a) => a !== '--dry-run');

  const paths = await prisma.path.findMany({
    where: targets.length > 0 ? { OR: [{ topic: { in: targets } }, { id: { in: targets } }] } : {},
    select: { id: true, topic: true, status: true, _count: { select: { concepts: true } } },
    orderBy: { topic: 'asc' },
  });
  if (targets.length > 0 && paths.length < targets.length) {
    const found = new Set(paths.flatMap((p) => [p.topic, p.id]));
    for (const t of targets.filter((t) => !found.has(t))) console.warn(`[backfill] no Path for '${t}'`);
  }

  const summary: { topic: string; outcome: string; added: number; resourced: number }[] = [];
  for (const p of paths) {
    // A map with no concepts has no spine to anchor frontier on (a crashed or
    // failed build) — that's ensurePathMap's reclaim path, not a backfill's.
    if (p._count.concepts === 0) {
      console.log(`[backfill] ${p.topic}: skipping (${p.status}, no concepts)`);
      summary.push({ topic: p.topic, outcome: 'no-spine', added: 0, resourced: 0 });
      continue;
    }
    const frontier = await prisma.concept.count({
      where: { pathId: p.id, membership: ConceptMembership.frontier },
    });
    if (dryRun) {
      console.log(`[backfill] ${p.topic}: ${frontier === 0 ? 'WOULD RUN' : `has ${frontier} frontier, would skip`}`);
      continue;
    }

    console.log(`[backfill] ${p.topic} (${p.id}) starting…`);
    const start = Date.now();
    try {
      const result = await ensureFrontier({ pathId: p.id });
      console.log(`[backfill] ${p.topic}: ${result.outcome} in ${((Date.now() - start) / 1000).toFixed(1)}s`, result);
      summary.push({ topic: p.topic, outcome: result.outcome, added: result.added, resourced: result.resourced });
    } catch (err) {
      // One map's failure shouldn't abort the sweep — report it and move on.
      console.error(`[backfill] ${p.topic}: FAILED`, err instanceof Error ? err.message : err);
      summary.push({ topic: p.topic, outcome: 'failed', added: 0, resourced: 0 });
    }
  }

  if (!dryRun) {
    console.log('\n[backfill] summary:');
    for (const s of summary) {
      console.log(`  ${s.topic}: ${s.outcome} added=${s.added} resourced=${s.resourced}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
