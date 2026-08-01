// Rung-0 coverage diagnostic (rung0-starvation plan, block R0).
//
//   npx tsx --env-file=.env.local scripts/rung0-coverage.ts <topic...> [--all-concepts]
//   DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local scripts/rung0-coverage.ts precalculus
//
// READ-ONLY. Writes nothing. Costs one query embedding per concept examined
// (searchNearbyResources embeds the concept title), so it is safe to re-run and
// safe to run mid-drain.
//
// WHAT IT MEASURES. `sourceForConcept` counts rung-0 (library) hits toward
// targetCount, so `webShortfall(targetCount, hits) === 0` means the web rungs
// never run for that concept. This replays rung 0's exact query per spine hole
// and reports the resulting web budget — a hole with 0 shortfall is permanently
// unfillable by any current code path.
//
// TWO THINGS ARE RE-DERIVED RATHER THAN IMPORTED, because the real ones are not
// reachable from a read-only script. Both are verbatim mirrors; a divergence here
// would measure a query this codebase never issues:
//
//   1. `libraryRung` (web-fallback.ts) is module-private. `rung0` below is a copy
//      of it: same relatedTopics(topic) expansion, same REJUDGE_ROUTE_MAX_DISTANCE,
//      limit = REMEDIATION_SOURCE_TARGET_COUNT, and the same exclusion of rows
//      already attached to the demanding concept. `webShortfall` IS imported —
//      the arithmetic under test must be the real one.
//   2. `recomputeReadiness` (recompute-readiness.ts) WRITES Path.status, which a
//      diagnostic must not do. The hole set here comes from the pure
//      `computeReadiness` over the same spine query that function runs.

import { ConceptMembership } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { searchNearbyResources } from '../src/lib/agents/tools/search-resources';
import { webShortfall } from '../src/lib/agents/tools/web-fallback';
import { computeReadiness } from '../src/lib/agents/map/readiness';
import { REMEDIATION_SOURCE_TARGET_COUNT, REJUDGE_ROUTE_MAX_DISTANCE } from '../src/lib/config';
import { relatedTopics } from '../src/types/resource';

// Verbatim mirror of web-fallback.ts's private `libraryRung` — see header note 1.
async function rung0(topic: string, conceptTitle: string, attachedIds: string[]) {
  return searchNearbyResources({
    topics: relatedTopics(topic),
    query: conceptTitle,
    maxDistance: REJUDGE_ROUTE_MAX_DISTANCE,
    limit: REMEDIATION_SOURCE_TARGET_COUNT,
    excludeIds: attachedIds,
  });
}

function membershipLabel(t: { topic: string; relevance: number; origin: string; isPrimary: boolean }): string {
  return `${t.topic}${t.isPrimary ? '*' : ''}(${t.relevance.toFixed(2)},${t.origin})`;
}

async function auditPath(topic: string, allConcepts: boolean): Promise<{ examined: number; saturated: number } | null> {
  const path = await prisma.path.findUnique({
    where: { topic },
    select: {
      id: true,
      status: true,
      concepts: {
        select: {
          slug: true,
          title: true,
          membership: true,
          primaryRelaxed: true,
          resources: { select: { resourceId: true, role: true, coverageScore: true } },
        },
        orderBy: { slug: 'asc' },
      },
    },
  });
  if (!path) {
    console.log(`\n### ${topic}: no Path — skipped`);
    return null;
  }

  const spine = path.concepts.filter((c) => c.membership === ConceptMembership.spine);
  const { holes } = computeReadiness(
    spine.map((c) => ({
      conceptSlug: c.slug,
      primaryRelaxed: c.primaryRelaxed,
      candidates: c.resources,
    })),
  );
  const holeSet = new Set(holes);
  const targets = allConcepts ? path.concepts : path.concepts.filter((c) => holeSet.has(c.slug));

  console.log(`\n### ${topic} (${path.status}) — ${spine.length} spine, ${holes.length} hole(s)`);
  console.log(`    related topics: [${relatedTopics(topic).join(', ')}]`);
  if (targets.length === 0) {
    console.log('    (nothing to examine)');
    return { examined: 0, saturated: 0 };
  }

  let saturated = 0;
  for (const c of targets) {
    const hits = await rung0(topic, c.title, c.resources.map((r) => r.resourceId));
    const shortfall = webShortfall(REMEDIATION_SOURCE_TARGET_COUNT, hits.length);
    if (shortfall === 0) saturated += 1;

    const marker = holeSet.has(c.slug) ? 'HOLE' : c.membership;
    console.log(
      `\n  [${marker}] ${c.slug} — rung0Hits=${hits.length}/${REMEDIATION_SOURCE_TARGET_COUNT} ` +
        `webShortfall=${shortfall}${shortfall === 0 ? '  ← WEB DISCOVERY SKIPPED' : ''}`,
    );
    if (hits.length === 0) continue;

    const rows = await prisma.resource.findMany({
      where: { id: { in: hits.map((h) => h.id) } },
      select: {
        id: true,
        title: true,
        status: true,
        topics: { select: { topic: true, relevance: true, origin: true, isPrimary: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const h of hits) {
      const row = byId.get(h.id);
      if (!row) continue;
      console.log(
        `      d=${h.distance.toFixed(3)}  ${row.status.padEnd(14)} ` +
          `[${row.topics.map(membershipLabel).join(', ')}]  ${row.title.slice(0, 56)}`,
      );
    }
  }

  console.log(`\n    -- ${topic}: examined=${targets.length} rung-0-saturated=${saturated}`);
  return { examined: targets.length, saturated };
}

async function main() {
  const args = process.argv.slice(2);
  const allConcepts = args.includes('--all-concepts');
  const topics = args.filter((a) => !a.startsWith('--'));
  if (topics.length === 0) {
    console.error('Usage: tsx --env-file=.env.local scripts/rung0-coverage.ts <topic...> [--all-concepts]');
    process.exit(1);
  }

  console.log(
    `rung-0 coverage — maxDistance=${REJUDGE_ROUTE_MAX_DISTANCE} limit=${REMEDIATION_SOURCE_TARGET_COUNT} ` +
      `scope=${allConcepts ? 'all concepts' : 'spine holes only'}`,
  );

  let resolved = 0;
  let examined = 0;
  let saturated = 0;
  for (const t of topics) {
    const result = await auditPath(t, allConcepts);
    if (!result) continue;
    resolved += 1;
    examined += result.examined;
    saturated += result.saturated;
  }

  console.log(`\nTOTAL: ${saturated}/${examined} concept(s) rung-0 saturated across ${resolved} Path(s)`);
  await prisma.$disconnect();
  process.exit(resolved === 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
