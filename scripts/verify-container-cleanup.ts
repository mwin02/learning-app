// Block 0 (docs/track-budget-fill-plan.md) — one-off data cleanup for container
// escapes: `atomic` resources over MAX_ATTACHABLE_DURATION_MIN that are attached
// to concepts (the 2026-07-03 audit found two: the 1,800m MIT OCW convex-
// optimization course and the 1,200m MML book, 3 ConceptResource links total).
//
// Dry-run by default (reports what it would do). With --apply it:
//   1. deletes the offending ConceptResource links,
//   2. flips each offending resource to decompositionStatus='human_review' so it
//      is no longer pickable (searchResources pickableOnly = active + atomic) —
//      an operator can later decompose or accept_atomic it via the review API,
//   3. re-sources each affected concept (sourceAndAttachConcept — live web
//      search + judge, the same primitive remediation uses) so a concept whose
//      readiness rested on the monster (foundations-of-machine-learning) is
//      refilled rather than left a hole,
//   4. prints before/after candidate counts per affected concept.
//
// LIVE driver (DB writes + web + LLM) — stays a manual script per the testing
// convention. Run: npx tsx --env-file=.env.local scripts/verify-container-cleanup.ts [--apply]
import { prisma } from '@/lib/db';
import { MAX_ATTACHABLE_DURATION_MIN } from '@/lib/config';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[container-cleanup] mode: ${apply ? 'APPLY' : 'dry-run'} (ceiling: ${MAX_ATTACHABLE_DURATION_MIN}min)`);

  const offenders = await prisma.resource.findMany({
    where: {
      decompositionStatus: 'atomic',
      durationMin: { gt: MAX_ATTACHABLE_DURATION_MIN },
    },
    select: {
      id: true,
      title: true,
      url: true,
      type: true,
      durationMin: true,
      conceptResources: {
        select: {
          id: true,
          concept: {
            select: {
              id: true,
              slug: true,
              title: true,
              isOnRamp: true,
              path: { select: { id: true, topic: true } },
            },
          },
        },
      },
    },
    orderBy: { durationMin: 'desc' },
  });

  if (offenders.length === 0) {
    console.log('[container-cleanup] no over-ceiling atomic resources found — nothing to do');
    return;
  }

  for (const r of offenders) {
    console.log(`\n${r.durationMin}min  ${r.type}  links=${r.conceptResources.length}  ${r.title}\n  ${r.url}`);
    for (const link of r.conceptResources) {
      console.log(`  -> ${link.concept.path.topic} / ${link.concept.slug}`);
    }
  }

  // Affected concepts, deduped (a concept could hold links to several offenders).
  const affected = new Map<
    string,
    { id: string; slug: string; title: string; isOnRamp: boolean; pathId: string; topic: string }
  >();
  for (const r of offenders) {
    for (const link of r.conceptResources) {
      affected.set(link.concept.id, {
        id: link.concept.id,
        slug: link.concept.slug,
        title: link.concept.title,
        isOnRamp: link.concept.isOnRamp,
        pathId: link.concept.path.id,
        topic: link.concept.path.topic,
      });
    }
  }

  if (!apply) {
    console.log(
      `\n[container-cleanup] dry-run: would detach ${offenders.reduce((s, r) => s + r.conceptResources.length, 0)} link(s), park ${offenders.length} resource(s) as human_review, and re-source ${affected.size} concept(s). Re-run with --apply.`,
    );
    return;
  }

  const before = new Map<string, number>();
  for (const c of affected.values()) {
    before.set(c.id, await prisma.conceptResource.count({ where: { conceptId: c.id } }));
  }

  // 1+2: detach + park, atomically per resource.
  for (const r of offenders) {
    await prisma.$transaction([
      prisma.conceptResource.deleteMany({ where: { resourceId: r.id } }),
      prisma.resource.update({ where: { id: r.id }, data: { decompositionStatus: 'human_review' } }),
    ]);
    console.log(`[container-cleanup] detached ${r.conceptResources.length} link(s) + parked: ${r.title}`);
  }

  // 3: re-source each affected concept (mastery-agnostic, like spine-hole
  // remediation). Sequential — each is a web-search + judge round.
  for (const c of affected.values()) {
    console.log(`[container-cleanup] re-sourcing ${c.topic} / ${c.slug} …`);
    const attached = await sourceAndAttachConcept({
      pathId: c.pathId,
      topic: c.topic,
      conceptId: c.id,
      slug: c.slug,
      title: c.title,
      isOnRamp: c.isOnRamp,
    });
    console.log(`[container-cleanup]   attached ${attached} new candidate(s)`);
  }

  // 4: before/after + a loud flag for any concept left without a teaches candidate.
  console.log('\n[container-cleanup] result:');
  for (const c of affected.values()) {
    const links = await prisma.conceptResource.findMany({
      where: { conceptId: c.id },
      select: { role: true },
    });
    const teaches = links.filter((l) => l.role === 'teaches').length;
    const flag = teaches === 0 ? '  ⚠️ NO teaches candidate — needs remediation' : '';
    console.log(
      `  ${c.topic} / ${c.slug}: ${before.get(c.id)} -> ${links.length} candidates (${teaches} teaches)${flag}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
