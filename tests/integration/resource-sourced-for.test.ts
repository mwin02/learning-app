// DB integration test for Block 1 sourcing provenance (ResourceSourcedFor):
// a parked (non-atomic) resource "sourced" twice under two different concepts
// gets one pair per concept, a re-demand under the same concept is a
// skipDuplicates no-op, and deleting a concept cascades its pairs away.
//
// Exercises the exact write the persistence tail performs — deriveSourcedForPairs
// over upsert outcomes, then `createMany … skipDuplicates` — without paying for
// the LLM discovery/decompose half of persistDiscovered.
//
// Self-cleaning: rows use a __verify_rsf__ marker, deleted in before/after.
// Skips cleanly when DATABASE_URL is unset (describeDb).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { deriveSourcedForPairs } from '@/lib/agents/tools/sourced-for';
import { describeDb } from './db';

const TOPIC = '__verify_rsf__';

let conceptAId: string;
let conceptBId: string;
let resourceId: string;

async function cleanup() {
  // Pairs cascade with both parents; delete the parents explicitly anyway so a
  // partially-seeded earlier run can't strand rows.
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
}

// The write the persistence tail performs for one sourcing run's outcomes.
async function recordRun(conceptId: string) {
  const pairs = deriveSourcedForPairs(conceptId, [
    { resourceId, decompositionStatus: 'human_review' },
  ]);
  await prisma.resourceSourcedFor.createMany({ data: pairs, skipDuplicates: true });
}

const pairsForResource = () =>
  prisma.resourceSourcedFor.findMany({ where: { resourceId }, select: { conceptId: true } });

describeDb('ResourceSourcedFor — provenance pairs', () => {
  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${TOPIC}src`, name: 'RSF source', url: 'https://verify-rsf.example.com', kind: 'community' },
      select: { id: true },
    });
    const path = await prisma.path.create({
      data: {
        topic: TOPIC,
        concepts: {
          create: [
            { slug: 'rsf-concept-a', title: 'RSF Concept A' },
            { slug: 'rsf-concept-b', title: 'RSF Concept B' },
          ],
        },
      },
      select: { concepts: { select: { id: true, slug: true } } },
    });
    conceptAId = path.concepts.find((c) => c.slug === 'rsf-concept-a')!.id;
    conceptBId = path.concepts.find((c) => c.slug === 'rsf-concept-b')!.id;
    // A parked container, as web-fallback leaves one that awaits human review.
    const resource = await prisma.resource.create({
      data: {
        slug: `${TOPIC}container`,
        topic: TOPIC,
        title: 'RSF parked container',
        url: 'https://verify-rsf.example.com/course',
        type: 'course',
        durationMin: 360,
        summary: 'parked container',
        difficulty: 'beginner',
        prerequisiteConcepts: [],
        conceptsTaught: [],
        status: 'pending_review',
        decompositionStatus: 'human_review',
        sourceId: source.id,
      },
      select: { id: true },
    });
    resourceId = resource.id;
  });
  afterAll(cleanup);

  it('sourcing under two concepts records two pairs', async () => {
    await recordRun(conceptAId);
    await recordRun(conceptBId);
    const pairs = await pairsForResource();
    expect(pairs.map((p) => p.conceptId).sort()).toEqual([conceptAId, conceptBId].sort());
  });

  it('re-demand under the same concept is a no-op (skipDuplicates)', async () => {
    await recordRun(conceptAId);
    expect(await pairsForResource()).toHaveLength(2);
  });

  it('deleting a concept cascades its pair away', async () => {
    await prisma.concept.delete({ where: { id: conceptAId } });
    const pairs = await pairsForResource();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].conceptId).toBe(conceptBId);
  });
});
