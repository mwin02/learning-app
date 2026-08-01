// DB integration test for topic filing T4a — the two halves of the bulk reclassifier
// that touch Postgres: `centroidMargins` (the first consumer of TopicCentroid, which
// shipped unread in T2a) and `applyReclassification` (the transactional write).
//
// The decision matrix itself is pure and covered exhaustively in
// src/lib/curation/reclassify.test.ts; nothing here re-tests it.
//
// Vectors are written directly (storeEmbedding) rather than produced by Vertex, so the
// expected similarities are exact and the test costs no LLM call.
//
// Self-cleaning marker topics; skips cleanly without DATABASE_URL. Run with the worker
// stopped (the queue/membership tables are shared with the compose workers).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { storeEmbedding } from '@/lib/ai/embeddings';
import {
  setPrimaryTopic,
  applyReclassification,
  checkMembershipInvariants,
} from '@/lib/curation/resource-topics';
import { refreshTopicCentroids, centroidMargins } from '@/lib/curation/topic-centroids';
import { describeDb } from './db';

const TOPIC = '__verify_rt4__';
const OTHER = '__verify_rt4_other__';
const DIM = 768;

// Unit vectors in the first three basis directions. `own` and `near` sit in the same
// direction (cosine 1.0 to their own centroid), `far` is orthogonal to both — so the
// margin signs below are exact, not approximate.
const basis = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

// MIN_CENTROID_MEMBERS is 20, so a marker topic can never earn a centroid of its own.
// That is deliberate here: it exercises the LEFT JOIN branch, which must return the row
// with null margins rather than dropping it from the result entirely.
const ids: Record<string, string> = {};
let baseline: Awaited<ReturnType<typeof checkMembershipInvariants>>;

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: { in: [TOPIC, OTHER] } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
  await prisma.topicCentroid.deleteMany({ where: { topic: { in: [TOPIC, OTHER] } } });
}

async function membershipsOf(resourceId: string) {
  return prisma.resourceTopic.findMany({
    where: { resourceId },
    select: { topic: true, relevance: true, origin: true, contested: true, isPrimary: true },
    orderBy: { topic: 'asc' },
  });
}

describeDb('topic filing T4a — reclassifier DB seams', () => {
  beforeAll(async () => {
    await cleanup();
    // checkMembershipInvariants is WHOLE-TABLE by design (that scope is the property it
    // exists to verify), and this is the shared dev DB — sibling tests seed Resource rows
    // directly, without memberships. So assert these writes add no NEW violation rather
    // than that the table is globally pristine.
    baseline = await checkMembershipInvariants();
    const source = await prisma.source.create({
      data: {
        slug: `${TOPIC}src`,
        name: 'Reclassify source',
        url: 'https://verify-rt4.example.com',
        kind: 'community',
      },
      select: { id: true },
    });
    for (const [i, name] of ['own', 'near', 'far'].entries()) {
      const r = await prisma.resource.create({
        data: {
          slug: `${TOPIC}${name}`,
          topic: TOPIC,
          title: `Reclassify ${name}`,
          url: `https://verify-rt4.example.com/${name}`,
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
      ids[name] = r.id;
      await storeEmbedding(r.id, basis(name === 'near' ? 0 : i));
      // The state the backlog is actually in: one inherited primary carrying the
      // placeholder relevance of 1.0.
      await setPrimaryTopic(r.id, TOPIC, { origin: 'inherited', relevance: 1.0 });
    }
    await refreshTopicCentroids();
  });

  afterAll(cleanup);

  it('returns a row with null margins when the topic has no qualifying centroid', async () => {
    // The LEFT JOIN branch. A row that vanished here would silently drop out of the
    // driver's report rather than showing up as "no margin available".
    const margins = await centroidMargins([ids.own]);
    const m = margins.get(ids.own);
    expect(m).toBeDefined();
    expect(m).toMatchObject({ own: null, margin: null });
  });

  it('measures similarity against the real centroids that DO qualify', async () => {
    // The marker rows have no centroid of their own, but the library's real topics do,
    // so the best-other side is exercised end to end against live data.
    const margins = await centroidMargins([ids.own, ids.far]);
    for (const id of [ids.own, ids.far]) {
      const m = margins.get(id)!;
      expect(m.best).toBeTruthy();
      expect(m.bestSim).toBeGreaterThanOrEqual(-1);
      expect(m.bestSim).toBeLessThanOrEqual(1);
    }
  });

  it('omits ids that do not exist or have no embedding', async () => {
    const margins = await centroidMargins([ids.own, 'no-such-resource-id']);
    expect(margins.has('no-such-resource-id')).toBe(false);
    expect(margins.has(ids.own)).toBe(true);
  });

  it('is a no-op on an empty id list (never a whole-table scan)', async () => {
    expect(await centroidMargins([])).toEqual(new Map());
  });

  it('re-scores the primary in place and flips it off `inherited`', async () => {
    await applyReclassification(ids.own, {
      primary: { topic: TOPIC, relevance: 0.8, origin: 'classifier', contested: false },
      secondaries: [],
    });
    const [m] = await membershipsOf(ids.own);
    expect(m).toMatchObject({
      topic: TOPIC,
      relevance: 0.8,
      origin: 'classifier',
      isPrimary: true,
      contested: false,
    });
  });

  it('records a disagreement as a contested primary plus a contested secondary, without refiling', async () => {
    await applyReclassification(ids.near, {
      primary: { topic: TOPIC, relevance: 0.3, origin: 'classifier', contested: true },
      secondaries: [{ topic: OTHER, relevance: 0.7, origin: 'classifier', contested: true }],
    });
    const rows = await membershipsOf(ids.near);
    expect(rows).toHaveLength(2);
    // The mirror still says the original topic — the whole point of the block.
    const resource = await prisma.resource.findUnique({
      where: { id: ids.near },
      select: { topic: true },
    });
    expect(resource?.topic).toBe(TOPIC);
    expect(rows.find((r) => r.isPrimary)).toMatchObject({ topic: TOPIC, contested: true });
    expect(rows.find((r) => !r.isPrimary)).toMatchObject({
      topic: OTHER,
      relevance: 0.7,
      contested: true,
    });
  });

  it('is idempotent — a second apply writes no duplicate membership', async () => {
    // The driver's resume selector normally prevents a re-run, but `--force` re-scores
    // rows that already have a verdict, so this has to hold.
    await applyReclassification(ids.near, {
      primary: { topic: TOPIC, relevance: 0.3, origin: 'classifier', contested: true },
      secondaries: [{ topic: OTHER, relevance: 0.7, origin: 'classifier', contested: true }],
    });
    expect(await membershipsOf(ids.near)).toHaveLength(2);
  });

  it('writes nothing at all for a no-evidence decision', async () => {
    // The placeholder 1.0 must survive: replacing it with a measured-looking 0.0 would
    // claim we checked when we could not.
    await applyReclassification(ids.far, { primary: null, secondaries: [] });
    const [m] = await membershipsOf(ids.far);
    expect(m).toMatchObject({ origin: 'inherited', relevance: 1, isPrimary: true });
  });

  it('adds no new T1 membership-invariant violation across every write above', async () => {
    expect(await checkMembershipInvariants()).toEqual(baseline);
  });
});
