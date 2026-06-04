// Phase 2.5b-4 — backfill: decompose the existing seed library.
//
// Runs the decomposition router over the seed's container-shaped rows (YouTube
// playlists, doc-course trees) and applies the result: playlists/tutorials are
// exploded into atomic children, references/single pages are kept atomic, and
// undecomposable containers (e.g. JS-rendered SPAs) are parked as human_review.
// Idempotent: skips rows already decomposed; retries 'pending'; re-evaluates
// reroute-to-atomic rows (accepted for a rarely-run manual script).
//
// Run (preview, no writes):  npx tsx --env-file=.env.local scripts/decompose-seed-library.ts --dry-run
// Run (apply):               npx tsx --env-file=.env.local scripts/decompose-seed-library.ts
//   --limit N   process at most N candidates (for spot-checking)

import { prisma } from '@/lib/db';
import { classify } from '@/lib/agents/decomposition/router';
import { decompose } from '@/lib/agents/decomposition/decompose';
import { decomposeExisting } from '@/lib/agents/decomposition/upsert-resource';

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const li = argv.indexOf('--limit');
  const limit = li >= 0 ? Number(argv[li + 1]) : Infinity;
  return { dryRun, limit };
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  console.log(`[backfill] mode=${dryRun ? 'DRY-RUN (no writes)' : 'APPLY'}${Number.isFinite(limit) ? ` limit=${limit}` : ''}`);

  // Top-level seed rows not yet resolved: atomic (never evaluated) or pending
  // (a prior transient failure to retry). Already-decomposed/human_review rows
  // are left alone.
  const rows = await prisma.resource.findMany({
    where: { origin: 'seed', parentResourceId: null, decompositionStatus: { in: ['atomic', 'pending'] } },
    select: {
      id: true, url: true, title: true, type: true, topic: true,
      difficulty: true, summary: true, conceptsTaught: true,
    },
    orderBy: [{ topic: 'asc' }, { title: 'asc' }],
  });

  const candidates = rows.filter((r) => classify({ url: r.url, type: r.type }).kind !== 'atomic');
  console.log(`[backfill] ${candidates.length} container-candidates of ${rows.length} seed rows\n`);

  const totals: Record<string, number> = { decomposed: 0, atomic: 0, human_review: 0, pending: 0 };
  let processed = 0;

  for (const r of candidates) {
    if (processed >= limit) break;
    processed += 1;

    const result = await decompose({
      url: r.url, title: r.title, type: r.type, topic: r.topic,
      difficulty: r.difficulty, summary: r.summary, conceptsTaught: r.conceptsTaught,
    });
    totals[result.status] = (totals[result.status] ?? 0) + 1;

    const childInfo = result.children.length > 0 ? ` (${result.children.length} children)` : '';
    console.log(`  ${result.status.padEnd(13)} ${r.title.slice(0, 56)}${childInfo}`);

    if (!dryRun) {
      const applied = await decomposeExisting(r.id, result);
      if (applied.childrenCreated !== result.children.length) {
        console.log(`      ↳ ${applied.childrenCreated}/${result.children.length} children created (rest were existing URLs)`);
      }
    }
  }

  console.log('\n[backfill] summary:', JSON.stringify(totals));
  if (dryRun) console.log('[backfill] DRY-RUN — no rows were modified.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
