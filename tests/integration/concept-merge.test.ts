// DB integration test for the Block 3 concept-merge sink + finding resolution — the
// substantive, DB-touching half of the operator worklist API (the route handler is a
// thin wrapper over these). Exercises the exact transaction the route runs. No LLM.
//
// Self-cleaning: all rows use a __verify_merge__ marker, deleted in before/afterAll.
// Skips cleanly when DATABASE_URL is unset (describeDb).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { ConceptMembership, ConceptResourceRole, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveFinding, applyConceptMerge } from '@/lib/agents/map/path-review';
import { MergeCycleError } from '@/lib/agents/map/merge-concept';
import { describeDb } from './db';

const MARK = '__verify_merge__';
const TOPIC = `${MARK}-topic`;
const TOPIC_CYCLE = `${MARK}-topic-cycle`;

async function cleanup() {
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

// A throwaway teaches resource; returns its id.
async function makeResource(sourceId: string, suffix: string): Promise<string> {
  const r = await prisma.resource.create({
    data: {
      slug: `${MARK}-${suffix}`, topic: TOPIC, title: `Res ${suffix}`, url: `https://example.invalid/${suffix}`,
      type: 'article', durationMin: 30, summary: 's', difficulty: 'beginner', sourceId,
    },
  });
  return r.id;
}

describeDb('concept merge (Block 3)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('collapses a duplicate into the winner: repoints edges + resources, drops the loser, stays spine_ready', async () => {
    const source = await prisma.source.create({
      data: { slug: `${MARK}-src`, name: 'src', url: 'https://example.invalid', kind: 'community' },
    });
    const [rShared, rLoserOnly, rWinner] = await Promise.all([
      makeResource(source.id, 'shared'),
      makeResource(source.id, 'loseronly'),
      makeResource(source.id, 'winner'),
    ]);

    const path = await prisma.path.create({ data: { topic: TOPIC, status: 'spine_ready' } });
    const mk = (slug: string) =>
      prisma.concept.create({ data: { pathId: path.id, slug, title: slug, membership: ConceptMembership.spine } });
    const [winner, loser, pre, dep] = await Promise.all([mk('winner'), mk('loser'), mk('pre'), mk('dep')]);

    // Edges: pre → loser (prereq), loser → dep (dependent), pre → winner (already there).
    await prisma.conceptPrereq.createMany({
      data: [
        { pathId: path.id, fromConceptId: pre.id, toConceptId: loser.id },
        { pathId: path.id, fromConceptId: loser.id, toConceptId: dep.id },
        { pathId: path.id, fromConceptId: pre.id, toConceptId: winner.id },
      ],
    });
    // Resources: winner teaches rWinner + rShared; loser teaches rShared (dup) + rLoserOnly.
    // pre + dep each get a qualifying primary so the Path is legitimately spine_ready
    // (every spine concept has a teaches primary ≥ the coverage floor).
    await prisma.conceptResource.createMany({
      data: [
        { conceptId: winner.id, resourceId: rWinner, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
        { conceptId: winner.id, resourceId: rShared, role: ConceptResourceRole.teaches, coverageScore: 0.7 },
        { conceptId: loser.id, resourceId: rShared, role: ConceptResourceRole.teaches, coverageScore: 0.7 },
        { conceptId: loser.id, resourceId: rLoserOnly, role: ConceptResourceRole.teaches, coverageScore: 0.8 },
        { conceptId: pre.id, resourceId: rWinner, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
        { conceptId: dep.id, resourceId: rWinner, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
      ],
    });
    const finding = await prisma.pathReview.create({
      data: { pathId: path.id, kind: 'duplication', conceptSlugs: ['winner', 'loser'], message: 'dup' },
    });

    // Run the exact transaction the route runs.
    const raceLost = await prisma.$transaction(async (tx) => {
      const won = await resolveFinding(finding.id, 'merged', tx);
      if (!won) return true;
      await applyConceptMerge(tx, { pathId: path.id, winnerId: winner.id, loserId: loser.id });
      return false;
    });
    expect(raceLost).toBe(false);

    // Loser gone; no orphaned rows referencing it.
    expect(await prisma.concept.findUnique({ where: { id: loser.id } })).toBeNull();
    expect(await prisma.conceptResource.count({ where: { conceptId: loser.id } })).toBe(0);
    expect(await prisma.conceptPrereq.count({ where: { OR: [{ fromConceptId: loser.id }, { toConceptId: loser.id }] } })).toBe(0);

    // Winner absorbed the loser-only resource; the shared one deduped (no double link).
    const winnerResources = await prisma.conceptResource.findMany({ where: { conceptId: winner.id }, select: { resourceId: true } });
    const winnerResIds = new Set(winnerResources.map((r) => r.resourceId));
    expect(winnerResIds).toEqual(new Set([rWinner, rShared, rLoserOnly]));

    // Edges repointed onto the winner: pre → winner (already present, not duplicated) + winner → dep.
    const winnerEdges = await prisma.conceptPrereq.findMany({
      where: { pathId: path.id },
      select: { fromConceptId: true, toConceptId: true },
    });
    expect(winnerEdges).toContainEqual({ fromConceptId: pre.id, toConceptId: winner.id });
    expect(winnerEdges).toContainEqual({ fromConceptId: winner.id, toConceptId: dep.id });
    expect(winnerEdges.filter((e) => e.fromConceptId === pre.id && e.toConceptId === winner.id)).toHaveLength(1);

    // Finding resolved; Path still spine_ready.
    const resolved = await prisma.pathReview.findUnique({ where: { id: finding.id } });
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.resolution).toBe('merged');
    expect((await prisma.path.findUnique({ where: { id: path.id } }))?.status).toBe(PathStatus.spine_ready);

    // Re-deciding the now-resolved finding loses (the 409 basis in the route).
    expect(await resolveFinding(finding.id, 'dismissed')).toBe(false);
  });

  it('refuses a merge that would create a prerequisite cycle (nothing deleted)', async () => {
    const source = await prisma.source.create({
      data: { slug: `${MARK}-src2`, name: 'src2', url: 'https://example.invalid/2', kind: 'community' },
    });
    const path = await prisma.path.create({ data: { topic: TOPIC_CYCLE, status: 'spine_ready' } });
    const mk = (slug: string) =>
      prisma.concept.create({ data: { pathId: path.id, slug, title: slug, membership: ConceptMembership.spine } });
    const [winner, loser, mid] = await Promise.all([mk('w'), mk('l'), mk('m')]);
    // w → m → l. Merging l into w would repoint m → l to m → w, closing w → m → w.
    await prisma.conceptPrereq.createMany({
      data: [
        { pathId: path.id, fromConceptId: winner.id, toConceptId: mid.id },
        { pathId: path.id, fromConceptId: mid.id, toConceptId: loser.id },
      ],
    });

    await expect(
      prisma.$transaction((tx) => applyConceptMerge(tx, { pathId: path.id, winnerId: winner.id, loserId: loser.id })),
    ).rejects.toBeInstanceOf(MergeCycleError);

    // Loser survives — the tx rolled back.
    expect(await prisma.concept.findUnique({ where: { id: loser.id } })).not.toBeNull();
  });
});
