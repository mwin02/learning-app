// DB integration test for topic filing T3: a URL rediscovered under a second topic may
// JOIN that topic — but only by clearing the same k-NN guardrail a fresh filing does,
// measured against the EXISTING row's embedding.
//
// This is the plan's defect mechanic #5: pre-T3, upsertResource logged
// `skip cross-topic URL collision` and returned, so a mislabel stayed permanent even once
// the right topic existed. The rule that keeps this from being a free membership is the
// same one the whole plan rests on — a collision is the SEARCHED topic asserting
// relevance, which is a hypothesis to test, not evidence to accept.
//
// The library is seeded with two synthetic pools of identical one-hot vectors, which sit
// at cosine distance 0 from the row under test and so deterministically win the k-NN
// against every real (dense) embedding in the shared dev DB. No Vertex call: every vector
// here is supplied.
//
// Self-cleaning marker topics; skips cleanly without DATABASE_URL. Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { checkMembershipInvariants } from '@/lib/curation/resource-topics';
import { KNN_K, MAX_MEMBERSHIPS, type FilingDecision } from '@/lib/curation/topic-knn';
import { searchResources } from '@/lib/agents/tools/search-resources';
import { describeDb } from './db';

const PREFIX = '__verify_collide';
const HOME = `${PREFIX}_home__`; // where the row is already filed
const NEAR = `${PREFIX}_near__`; // a pool the row genuinely sits in — should be admitted
const FAR = `${PREFIX}_far__`; // a well-populated pool the row is nowhere near — declined
const FILLER = `${PREFIX}_filler__`; // pads a row up to the membership cap

const DIM = 768;
const oneHot = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));
const NEAR_VEC = oneHot(0);
const FAR_VEC = oneHot(1);

const url = (name: string) => `https://verify-collide.example.com/${name}`;

const filingUnder = (topic: string, secondaries: string[] = []): FilingDecision => ({
  primary: { topic, relevance: 0.9, origin: 'classifier', contested: false },
  secondaries: secondaries.map((t) => ({ topic: t, relevance: 0.3, origin: 'classifier' as const, contested: false })),
  reason: 'classifier',
});

const input = (name: string, title: string) => ({
  url: url(name),
  title,
  type: 'article',
  difficulty: 'beginner',
  durationMin: 10,
  durationSource: 'estimated' as const,
  summary: 'collision fixture',
  prerequisiteConcepts: [],
  conceptsTaught: [],
});

const atomic = { status: 'atomic' as const, children: [] };

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: { startsWith: PREFIX } } });
  await prisma.resource.deleteMany({ where: { url: { startsWith: 'https://verify-collide.example.com/' } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: PREFIX } } });
}

// A pool of KNN_K identical rows, so that pool is both vouchable (>= MIN_VOUCHABLE_POOL)
// and the unanimous plurality for anything sharing its vector.
async function seedPool(topic: string, vector: number[]) {
  const source = await prisma.source.upsert({
    where: { slug: `${PREFIX}_src__` },
    update: {},
    create: { slug: `${PREFIX}_src__`, name: 'collision fixture', url: 'https://verify-collide.example.com', kind: 'community', trustScore: 0.5 },
    select: { id: true },
  });
  for (let i = 0; i < KNN_K; i++) {
    const row = await prisma.resource.create({
      data: {
        slug: `${topic}-${i}`,
        topic,
        title: `${topic} pool ${i}`,
        url: url(`${topic}-${i}`),
        type: 'article',
        durationMin: 10,
        durationSource: 'estimated' as const,
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
    // Both halves matter, for different consumers: `Resource.topic` is what topicPools()
    // counts and what the k-NN neighbour query votes with (T4e made those the same
    // currency), while the membership is what T1's retrieval predicate matches on.
    await prisma.resourceTopic.create({
      data: { resourceId: row.id, topic, isPrimary: true, relevance: 1, origin: 'inherited' },
    });
    await prisma.$executeRaw`UPDATE "Resource" SET embedding = ${`[${vector.join(',')}]`}::vector WHERE id = ${row.id}`;
  }
}

const membershipsOf = (resourceId: string) =>
  prisma.resourceTopic.findMany({
    where: { resourceId },
    select: { topic: true, relevance: true, origin: true, isPrimary: true, contested: true },
    orderBy: { topic: 'asc' },
  });

describeDb('upsertResource — cross-topic collisions become memberships (T3)', () => {
  let baseline: Awaited<ReturnType<typeof checkMembershipInvariants>>;
  let subjectId: string;

  beforeAll(async () => {
    await cleanup();
    // Whole-table by design, and this is the shared dev DB — assert no NEW violation.
    baseline = await checkMembershipInvariants();
    await seedPool(NEAR, NEAR_VEC);
    await seedPool(FAR, FAR_VEC);

    const res = await upsertResource(HOME, input('subject', 'The contested page'), atomic, NEAR_VEC, filingUnder(HOME));
    expect(res.outcome).toBe('inserted');
    subjectId = res.resourceId!;
  });
  afterAll(cleanup);

  it('admits the rediscovering topic when the existing row sits in its pool', async () => {
    const res = await upsertResource(NEAR, input('subject', 'The contested page'), atomic, NEAR_VEC, filingUnder(NEAR));

    // Not an insert (the row existed) and emphatically not a skip (the row is now
    // reachable from a topic it could never be reached from before).
    expect(res.outcome).toBe('membership_added');
    expect(res.resourceId).toBe(subjectId);
    expect(res.atomicIds).toEqual([]);

    const added = (await membershipsOf(subjectId)).find((m) => m.topic === NEAR)!;
    expect(added).toMatchObject({ origin: 'collision', isPrimary: false, contested: false });
    // The MEASURED purity — all KNN_K neighbours are NEAR — never the schema default 1.0
    // by accident. (Here they coincide numerically; the origin/relevance pairing is what
    // the T4 origin-aware minRelevance will read.)
    expect(added.relevance).toBeCloseTo(1);
  });

  it('leaves the primary and the mirror alone — a collision is always a secondary', async () => {
    const rows = await membershipsOf(subjectId);
    expect(rows.filter((r) => r.isPrimary).map((r) => r.topic)).toEqual([HOME]);
    const mirror = await prisma.resource.findUniqueOrThrow({ where: { id: subjectId }, select: { topic: true } });
    expect(mirror.topic).toBe(HOME);
  });

  it('makes the row retrievable from the rediscovering topic', async () => {
    // The point of the whole exercise: retrieval is an EXISTS over "ResourceTopic".
    const hits = await searchResources({ topics: [NEAR], statuses: ['pending_review'] });
    expect(hits.map((r) => r.id)).toContain(subjectId);
  });

  it('declines a topic the neighbourhood does not support, even with a healthy pool', async () => {
    // FAR has a full pool, so this is a genuine rejection, not the unvouchable-pool path:
    // "two topics found the same page" is not evidence.
    const res = await upsertResource(FAR, input('subject', 'The contested page'), atomic, NEAR_VEC, filingUnder(FAR));
    expect(res.outcome).toBe('skipped');
    expect((await membershipsOf(subjectId)).map((m) => m.topic)).not.toContain(FAR);
  });

  it('does nothing when the row is rediscovered under the topic it is already filed as', async () => {
    const before = await membershipsOf(subjectId);
    const res = await upsertResource(HOME, input('subject', 'The contested page'), atomic, NEAR_VEC, filingUnder(HOME));
    expect(res.outcome).toBe('skipped');
    expect(await membershipsOf(subjectId)).toHaveLength(before.length);
  });

  it('declines when the existing row has no embedding', async () => {
    // No vector → no neighbours → no evidence. The guardrail has nothing to test against,
    // and a collision is never admitted on the searched topic's say-so alone.
    const seeded = await upsertResource(HOME, input('unembedded', 'No vector here'), atomic, null, filingUnder(HOME));
    expect(seeded.outcome).toBe('inserted');

    const res = await upsertResource(NEAR, input('unembedded', 'No vector here'), atomic, NEAR_VEC, filingUnder(NEAR));
    expect(res.outcome).toBe('skipped');
    expect((await membershipsOf(seeded.resourceId!)).map((m) => m.topic)).toEqual([HOME]);
  });

  it('declines once the row is at the membership cap', async () => {
    // Collision rows count against the cap — the guard against a generic "intro to
    // programming" page joining every topic, one rediscovery at a time.
    const capped = await upsertResource(
      HOME,
      input('capped', 'Already at the cap'),
      atomic,
      NEAR_VEC,
      filingUnder(HOME, [`${FILLER}a`, `${FILLER}b`]),
    );
    expect(await membershipsOf(capped.resourceId!)).toHaveLength(MAX_MEMBERSHIPS);

    const res = await upsertResource(NEAR, input('capped', 'Already at the cap'), atomic, NEAR_VEC, filingUnder(NEAR));
    expect(res.outcome).toBe('skipped');
    expect(await membershipsOf(capped.resourceId!)).toHaveLength(MAX_MEMBERSHIPS);
  });

  it('keeps the pre-T3 log-and-skip for callers that gathered no evidence', async () => {
    // The seed/verify paths supply no filing. They gathered no evidence about this
    // discovery, so none may be inferred on their behalf — even though this row would
    // clear the guardrail comfortably if they had.
    const seeded = await upsertResource(HOME, input('nofiling', 'Would clear it'), atomic, NEAR_VEC, filingUnder(HOME));
    expect(seeded.outcome).toBe('inserted');

    const res = await upsertResource(NEAR, input('nofiling', 'Would clear it'), atomic);
    expect(res.outcome).toBe('skipped');
    expect((await membershipsOf(seeded.resourceId!)).map((m) => m.topic)).toEqual([HOME]);
  });

  it('adds no membership-invariant violation', async () => {
    const counts = await checkMembershipInvariants();
    expect(counts).toEqual(baseline);
  });
});
