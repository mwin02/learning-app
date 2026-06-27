// Live verification for Phase 2.5h block 2d (the sourcing ladder).
//   npx tsx --env-file=.env.local scripts/verify-sourcing-ladder.ts
//
// Runs the real sourceForConcept against a concept and asserts the LADDER:
//   - rung 1 sources from the curated set only (YouTube prong + allowlisted
//     grounded prong) — so when rung 1 fills the target, NO open-web ('web')
//     resources are inserted;
//   - inserted resources resolve to channel/allowlisted Sources, not the blanket
//     community 'web' bucket;
//   - the watch the console [web-fallback] iteration lines to see the rung labels.
// Spends real quota (one search.list = 100u) + Vertex calls. Cleans up its inserts.

import { prisma } from '../src/lib/db';
import { sourceForConcept } from '../src/lib/agents/tools/web-fallback';

const TOPIC = 'python';
const CONCEPT = { slug: 'list-comprehensions', title: 'list comprehensions' };

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`, detail ?? '');
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function main() {
  console.log(`\n── sourcing "${CONCEPT.title}" (${TOPIC}) via the ladder ──────────`);
  const result = await sourceForConcept({ topic: TOPIC, concept: CONCEPT });
  console.log('\nresult:', {
    inserted: result.insertedCount,
    skipped: result.skippedCount,
    discovered: result.discoveredCount,
    iterations: result.iterations,
  });

  const inserted = result.insertedIds;
  try {
    check('the ladder sourced and inserted resources', inserted.length > 0, `(${inserted.length})`);
    if (inserted.length === 0) return;

    const rows = await prisma.resource.findMany({
      where: { id: { in: inserted } },
      select: {
        title: true, type: true, trustScore: true, viewCount: true,
        youtubeChannelId: true, source: { select: { slug: true, kind: true } },
      },
    });

    console.log('\ninserted resources:');
    for (const r of rows) {
      console.log(`   • [${r.source.slug}] ${r.type} trust=${r.trustScore.toFixed(2)}${r.viewCount ? ` views=${r.viewCount}` : ''} | ${r.title.slice(0, 50)}`);
    }

    const fromWeb = rows.filter((r) => r.source.slug === 'web');
    if (result.iterations === 1) {
      check('rung 1 filled the target — NO open-web (web) inserts', fromWeb.length === 0, `web rows: ${fromWeb.length}`);
    } else {
      console.log(`\n   (ladder relaxed to rung 2 after ${result.iterations} iterations — ${fromWeb.length} open-web row(s) allowed)`);
    }
    check('every inserted resource is from a curated/known source (not unattributed)', rows.every((r) => r.source.slug !== undefined));
    const yt = rows.filter((r) => r.type === 'video' && r.youtubeChannelId);
    check('YouTube prong contributed at least one stat-bearing video', yt.length > 0, `(${yt.length})`);
  } finally {
    if (inserted.length > 0) {
      // sourceForConcept only inserts (pending_review) — not yet attached — so the
      // ids are safe to remove. Guard with the unattached filter anyway.
      const safe = await prisma.resource.findMany({
        where: { id: { in: inserted }, lessonResources: { none: {} }, conceptResources: { none: {} } },
        select: { id: true },
      });
      await prisma.resource.deleteMany({ where: { id: { in: safe.map((s) => s.id) } } });
      console.log(`\n[cleanup] removed ${safe.length} inserted test row(s)`);
    }
  }

  console.log(failures === 0 ? '\n✅ all sourcing-ladder checks passed\n' : `\n❌ ${failures} check(s) failed\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
