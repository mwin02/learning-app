// DB helper for the review-map-findings skill. Run from the repo root with the
// app's env so it reuses the SAME Prisma client + the app's own merge/readiness
// logic (no reimplementation, so it can't drift from production):
//   npx tsx --env-file=.env.local .claude/skills/review-map-findings/scripts/map-review.ts <cmd> ...
//
//   inspect <topic|pathId> [slug ...]
//       No slugs: list every concept (membership + whether it has a qualifying
//       primary). With slugs: for each, its membership, prereq edges (in/out, by
//       slug), and resource links (role + coverage) — enough to pick a merge winner
//       and to spot a REDUNDANT node (all its resources already on the other).
//   plan <topic|pathId> <winnerSlug> <loserSlug>
//       READ-ONLY dry-run of merging loser→winner: wouldCycle, how many edges would
//       be created, how many resource links would move, and whether the loser is
//       redundant (0 links to move → its resources are all already on the winner).
//   delete-node <topic|pathId> <slug> <reviewId>
//       The delete-NOT-repoint escape hatch for a redundant node whose repoint-merge
//       would cycle (the database-views case): resolve the finding as `merged`,
//       delete the concept (cascading its edges + links), recompute readiness — in
//       one transaction. Refuses if the finding is already resolved.

import { prisma } from '@/lib/db';
import { planConceptMerge } from '@/lib/agents/map/merge-concept';
import { resolveFinding } from '@/lib/agents/map/path-review';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { hasQualifyingPrimary } from '@/lib/agents/map/readiness';

async function resolvePathId(arg: string): Promise<string> {
  const byTopic = await prisma.path.findUnique({ where: { topic: arg }, select: { id: true } });
  if (byTopic) return byTopic.id;
  const byId = await prisma.path.findUnique({ where: { id: arg }, select: { id: true } });
  if (byId) return byId.id;
  throw new Error(`No Path found for topic or id '${arg}'.`);
}

async function inspect(pathArg: string, slugs: string[]) {
  const pathId = await resolvePathId(pathArg);
  if (slugs.length === 0) {
    const concepts = await prisma.concept.findMany({
      where: { pathId },
      orderBy: [{ membership: 'asc' }, { slug: 'asc' }],
      select: { slug: true, membership: true, primaryRelaxed: true, resources: { select: { role: true, coverageScore: true } } },
    });
    for (const c of concepts) {
      const covered = hasQualifyingPrimary({ conceptSlug: c.slug, primaryRelaxed: c.primaryRelaxed, candidates: c.resources.map((r) => ({ resourceId: '', role: r.role, coverageScore: r.coverageScore })) });
      console.log(`${c.membership.padEnd(8)} ${c.slug}${c.primaryRelaxed ? ' [RELAXED]' : ''}${covered ? '' : ' [NO-PRIMARY]'}`);
    }
    return;
  }
  for (const slug of slugs) {
    const c = await prisma.concept.findFirst({
      where: { pathId, slug },
      select: {
        slug: true, title: true, membership: true, primaryRelaxed: true,
        resources: { select: { resourceId: true, role: true, coverageScore: true } },
        prereqsIn: { select: { from: { select: { slug: true } } } },
        prereqsOut: { select: { to: { select: { slug: true } } } },
      },
    });
    if (!c) { console.log(`(no concept '${slug}')`); continue; }
    console.log(`\n${c.slug} — "${c.title}" [${c.membership}${c.primaryRelaxed ? ', RELAXED' : ''}]`);
    console.log(`  prereqs (learn-before → this): ${c.prereqsIn.map((e) => e.from.slug).join(', ') || '(none)'}`);
    console.log(`  dependents (this → learn-after): ${c.prereqsOut.map((e) => e.to.slug).join(', ') || '(none)'}`);
    console.log(`  resources: ${c.resources.map((r) => `${r.resourceId}(${r.role} ${r.coverageScore.toFixed(2)})`).join(', ') || '(none)'}`);
  }
}

async function plan(pathArg: string, winnerSlug: string, loserSlug: string) {
  const pathId = await resolvePathId(pathArg);
  const [edges, cs] = await Promise.all([
    prisma.conceptPrereq.findMany({ where: { pathId }, select: { fromConceptId: true, toConceptId: true } }),
    prisma.concept.findMany({ where: { pathId, slug: { in: [winnerSlug, loserSlug] } }, select: { id: true, slug: true, resources: { select: { id: true, resourceId: true } } } }),
  ]);
  const w = cs.find((c) => c.slug === winnerSlug);
  const l = cs.find((c) => c.slug === loserSlug);
  if (!w || !l) throw new Error(`Both '${winnerSlug}' and '${loserSlug}' must exist in the Path.`);

  const p = planConceptMerge({
    winnerId: w.id, loserId: l.id, edges,
    winnerResourceIds: new Set(w.resources.map((r) => r.resourceId)),
    loserResourceLinks: l.resources,
  });
  console.log(`merge ${loserSlug} → ${winnerSlug}:`);
  console.log(`  wouldCycle:       ${p.wouldCycle}${p.wouldCycle ? '  ← repoint-merge UNSAFE; consider the other winner, or delete-node if the loser is redundant' : ''}`);
  console.log(`  edgesToCreate:    ${p.edgesToCreate.length}`);
  console.log(`  resourceLinksMove:${p.resourceLinkIdsToMove.length}${p.resourceLinkIdsToMove.length === 0 ? '  ← loser is REDUNDANT (all its resources already on the winner)' : ''}`);
}

async function deleteNode(pathArg: string, slug: string, reviewId: string) {
  const pathId = await resolvePathId(pathArg);
  const result = await prisma.$transaction(async (tx) => {
    const won = await resolveFinding(reviewId, 'merged', tx);
    if (!won) throw new Error(`Finding ${reviewId} is not open (already resolved?) — nothing deleted.`);
    const concept = await tx.concept.findFirst({ where: { pathId, slug }, select: { id: true } });
    if (!concept) throw new Error(`No concept '${slug}' in Path ${pathId}.`);
    await tx.concept.delete({ where: { id: concept.id } });
    return recomputeReadiness(pathId, tx);
  });
  console.log(`deleted '${slug}'; finding ${reviewId} resolved=merged; Path status=${result.status}${result.holes.length ? ` holes=${result.holes.join(',')}` : ''}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'inspect': await inspect(rest[0], rest.slice(1)); break;
    case 'plan': await plan(rest[0], rest[1], rest[2]); break;
    case 'delete-node': await deleteNode(rest[0], rest[1], rest[2]); break;
    default:
      console.error('Usage: map-review.ts <inspect|plan|delete-node> ...');
      process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => { console.error(err instanceof Error ? err.message : err); await prisma.$disconnect(); process.exit(1); });
