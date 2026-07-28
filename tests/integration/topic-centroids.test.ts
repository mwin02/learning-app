// DB integration test for topic filing T2a: refreshTopicCentroids computes one centroid
// per topic as the mean of its pool's embeddings, keyed off MEMBERSHIP (ResourceTopic),
// excluding contested secondaries, idempotent on re-run, and dropping centroids whose
// pool has emptied.
//
// Vectors are written directly (storeEmbedding) rather than produced by Vertex, so this
// costs no LLM call and the expected mean is exact.
//
// Note: refreshTopicCentroids is whole-table by design, so this test also refreshes the
// real topics' centroids. That is harmless — the table is derived data, recomputable at
// any time by scripts/embed-resources.ts — but assertions here are scoped to the marker
// topics, never to whole-table counts.
//
// Self-cleaning marker topics; skips cleanly without DATABASE_URL. Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { storeEmbedding } from '@/lib/ai/embeddings';
import { setPrimaryTopic } from '@/lib/curation/resource-topics';
import { refreshTopicCentroids } from '@/lib/curation/topic-centroids';
import { describeDb } from './db';

const TOPIC = '__verify_centroid__';
const CONTESTED_TOPIC = '__verify_centroid_contested__';
const DIM = 768;

// Two orthogonal unit vectors, so the expected mean is exactly [0.5, 0.5, 0, …].
const basis = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
  await prisma.topicCentroid.deleteMany({ where: { topic: { in: [TOPIC, CONTESTED_TOPIC] } } });
}

async function centroidOf(topic: string) {
  const rows = await prisma.$queryRaw<{ v: string; memberCount: number }[]>`
    SELECT centroid::text AS v, "memberCount" FROM "TopicCentroid" WHERE topic = ${topic}
  `;
  if (rows.length === 0) return null;
  return { vec: rows[0].v.slice(1, -1).split(',').map(Number), memberCount: rows[0].memberCount };
}

describeDb('refreshTopicCentroids (T2a)', () => {
  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${TOPIC}src`, name: 'Centroid source', url: 'https://verify-centroid.example.com', kind: 'community' },
      select: { id: true },
    });
    for (const [i, name] of ['a', 'b'].entries()) {
      const r = await prisma.resource.create({
        data: {
          slug: `${TOPIC}${name}`,
          topic: TOPIC,
          title: `Centroid member ${name}`,
          url: `https://verify-centroid.example.com/${name}`,
          type: 'article',
          durationMin: 20,
          summary: 'member',
          difficulty: 'beginner',
          prerequisiteConcepts: [],
          conceptsTaught: [],
          status: 'active',
          sourceId: source.id,
        },
        select: { id: true },
      });
      await storeEmbedding(r.id, basis(i));
      await setPrimaryTopic(r.id, TOPIC, { origin: 'inherited' });
      // A contested SECONDARY on every member: excluded from retrieval, and so from the
      // centroid it would otherwise conjure out of unverified filings.
      await prisma.resourceTopic.create({
        data: { resourceId: r.id, topic: CONTESTED_TOPIC, isPrimary: false, contested: true },
      });
    }
  });
  afterAll(cleanup);

  it('writes the mean of the topic pool, and ignores contested secondaries', async () => {
    await refreshTopicCentroids();

    const c = await centroidOf(TOPIC);
    expect(c).not.toBeNull();
    expect(c!.memberCount).toBe(2);
    expect(c!.vec).toHaveLength(DIM);
    expect(c!.vec[0]).toBeCloseTo(0.5);
    expect(c!.vec[1]).toBeCloseTo(0.5);
    expect(c!.vec[2]).toBeCloseTo(0);

    expect(await centroidOf(CONTESTED_TOPIC)).toBeNull();
  });

  it('is idempotent on re-run', async () => {
    await refreshTopicCentroids();
    const c = await centroidOf(TOPIC);
    expect(c!.memberCount).toBe(2);
    expect(c!.vec[0]).toBeCloseTo(0.5);
  });

  it('drops the centroid of a topic whose pool has emptied', async () => {
    await prisma.resource.deleteMany({ where: { topic: TOPIC } });
    const { removed } = await refreshTopicCentroids();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await centroidOf(TOPIC)).toBeNull();
  });
});
