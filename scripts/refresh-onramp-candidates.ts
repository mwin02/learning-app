// Block 4 backfill: re-attach the on-ramp concept's candidates with the new
// on-ramp-aware pipeline (Lever A floor+cap + Lever C query+judge), repairing the
// magnet bloat in EXISTING maps (calculus' intro held 45). For each Path:
//
//   1. Identify the on-ramp concept: the persisted isOnRamp flag, else the
//      in-degree-0 root whose name reads as an intro (older maps predate the flag).
//   2. Re-run the on-ramp attach against the live library: onRampQuery search →
//      judge with the strict on-ramp rubric → selectAttachable (floor + cap).
//   3. Set isOnRamp on the chosen concept, replace its ConceptResource links with
//      the proposed set, recompute readiness — all in one transaction.
//
// Paths with NO intro-named root (e.g. machine-learning, built before the on-ramp
// concept existed) are reported as "needs rebuild" and left untouched — rebuild
// those with `seed-spine-maps.ts --force <topic>`, which re-authors the spine
// through Block 1's normalizeOnRamp.
//
// Dry-run by default; pass --apply to write. Optional --topic <slug> to scope.
//
//   npx tsx --env-file=.env.local scripts/refresh-onramp-candidates.ts [--apply] [--topic calculus]

import { prisma } from '../src/lib/db';
import { searchResources } from '../src/lib/agents/tools/search-resources';
import { judgeCandidates } from '../src/lib/agents/map/candidate-judge';
import { selectAttachable, onRampQuery } from '../src/lib/agents/map/attach-candidates';
import { recomputeReadiness } from '../src/lib/agents/map/recompute-readiness';
import { MAP_CANDIDATES_PER_CONCEPT } from '../src/lib/config';
import { relatedTopics } from '../src/types/resource';

const INTRO_RE = /intro|getting-started|onboarding/;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const topicArg = args[args.indexOf('--topic') + 1];
  const onlyTopic = args.includes('--topic') ? topicArg : undefined;

  console.log(apply ? '=== APPLY (writing) ===' : '=== DRY-RUN (no writes; pass --apply) ===');

  const paths = await prisma.path.findMany({
    where: onlyTopic ? { topic: onlyTopic } : undefined,
    select: { id: true, topic: true, status: true },
    orderBy: { topic: 'asc' },
  });

  const needRebuild: string[] = [];

  for (const path of paths) {
    const concepts = await prisma.concept.findMany({
      where: { pathId: path.id, membership: 'spine' },
      select: {
        id: true, slug: true, title: true, isOnRamp: true,
        prereqsIn: { select: { fromConceptId: true } },
        _count: { select: { resources: true } },
      },
    });
    const onramp =
      concepts.find((c) => c.isOnRamp) ??
      concepts.find((c) => c.prereqsIn.length === 0 && INTRO_RE.test(c.slug));

    if (!onramp) {
      needRebuild.push(path.topic);
      console.log(`\n### ${path.topic}: no on-ramp concept identified — REBUILD via seed --force`);
      continue;
    }

    const found = await searchResources({
      query: onRampQuery(onramp.title),
      topics: relatedTopics(path.topic),
      statuses: ['active'],
      pickableOnly: true,
      limit: MAP_CANDIDATES_PER_CONCEPT,
    });
    const judged = await judgeCandidates({
      conceptTitle: onramp.title, conceptSlug: onramp.slug, candidates: found, isOnRamp: true,
    });
    const kept = selectAttachable(judged);
    const titleById = new Map(found.map((f) => [f.id, f.title]));

    console.log(`\n### ${path.topic} — on-ramp ${onramp.slug}: ${onramp._count.resources} → ${kept.length} candidate(s)`);
    for (const k of kept) {
      console.log(`    ${k.role.padEnd(9)} ${k.coverageScore.toFixed(2)}  ${(titleById.get(k.resourceId) ?? k.resourceId).slice(0, 68)}`);
    }

    if (!apply) continue;

    const status = await prisma.$transaction(async (tx) => {
      if (!onramp.isOnRamp) await tx.concept.update({ where: { id: onramp.id }, data: { isOnRamp: true } });
      await tx.conceptResource.deleteMany({ where: { conceptId: onramp.id } });
      if (kept.length > 0) {
        await tx.conceptResource.createMany({
          data: kept.map((k) => ({ conceptId: onramp.id, resourceId: k.resourceId, role: k.role, coverageScore: k.coverageScore })),
        });
      }
      const r = await recomputeReadiness(path.id, tx);
      return r.status;
    });
    console.log(`    applied — Path status: ${status}`);
  }

  if (needRebuild.length > 0) {
    console.log(`\nNeeds rebuild (no on-ramp concept): ${needRebuild.join(', ')}`);
    console.log(`  → npx tsx --env-file=.env.local scripts/seed-spine-maps.ts --force ${needRebuild.join(' ')}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
