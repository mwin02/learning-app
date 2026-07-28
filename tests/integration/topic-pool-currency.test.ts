// DB integration test for topic filing T4e: topicPools() counts the VOTING population.
//
// The bug this pins: the quorum was measured in one currency and spent in another.
// `topicPools()` counted `ResourceTopic` rows, but `knnNeighbourTopics` /
// `knnNeighbourTopicsOf` vote with `Resource.topic` — so a secondary membership inflated
// a shelf's pool without ever being able to cast a vote for it. T4b's retention mechanic
// (a vacated primary is kept as an uncontested secondary) made that gap systematic, and it
// bit exactly at the boundary: `differential-equations` read pool 10 — vouchable by the
// letter of MIN_VOUCHABLE_POOL — while only 9 rows could vote for it, so k-NN could never
// vouch and its rows stayed permanently contested (As-built T4a item 7).
//
// This reproduces that shape in miniature: a shelf whose members are all SECONDARY
// memberships must read as an empty pool, because none of them votes for it.
//
// Self-cleaning marker topics; skips cleanly without DATABASE_URL. Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { topicPools } from '@/lib/curation/topic-knn';
import { describeDb } from './db';

const HOME = '__verify_pool_home__';
const GUEST = '__verify_pool_guest__';
const DIM = 768;
const N = 3;

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: HOME } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: HOME } } });
}

describeDb('topicPools — counts votes (Resource.topic), not memberships (T4e)', () => {
  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: {
        slug: `${HOME}_src`,
        name: 'pool currency fixture',
        url: 'https://verify-pool.example.com',
        kind: 'community',
        trustScore: 0.5,
      },
      select: { id: true },
    });
    const vec = `[${Array.from({ length: DIM }, (_, j) => (j === 0 ? 1 : 0)).join(',')}]`;
    for (let i = 0; i < N; i++) {
      const row = await prisma.resource.create({
        data: {
          slug: `${HOME}-${i}`,
          topic: HOME,
          title: `pool member ${i}`,
          url: `https://verify-pool.example.com/${i}`,
          type: 'article',
          durationMin: 10,
          summary: 'pool member',
          difficulty: 'beginner',
          prerequisiteConcepts: [],
          conceptsTaught: [],
          origin: 'agent',
          status: 'active',
          decompositionStatus: 'atomic',
          sourceId: source.id,
        },
        select: { id: true },
      });
      // Primary on HOME (this row's vote), plus an uncontested SECONDARY on GUEST —
      // exactly what T4b's retention leaves behind after a refile.
      await prisma.resourceTopic.createMany({
        data: [
          { resourceId: row.id, topic: HOME, isPrimary: true, relevance: 1, origin: 'inherited' },
          { resourceId: row.id, topic: GUEST, isPrimary: false, relevance: 0.8, origin: 'classifier' },
        ],
      });
      await prisma.$executeRaw`UPDATE "Resource" SET embedding = ${vec}::vector WHERE id = ${row.id}`;
    }
  });

  afterAll(cleanup);

  it('counts a row for the topic it votes with', async () => {
    expect((await topicPools()).get(HOME)).toBe(N);
  });

  it('does NOT count uncontested secondary memberships — they cast no k-NN vote', async () => {
    // Pre-T4e this read N, inflating GUEST's pool with rows that can never vouch for it.
    expect((await topicPools()).get(GUEST)).toBeUndefined();
  });

  it('agrees with the population the k-NN neighbour query votes from', async () => {
    const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM "Resource"
      WHERE topic = ${HOME}
        AND embedding IS NOT NULL
        AND "decompositionStatus"::text = 'atomic'
        AND status::text IN ('active', 'pending_review')
        AND origin::text <> 'generated'`;
    expect((await topicPools()).get(HOME)).toBe(c);
  });
});
