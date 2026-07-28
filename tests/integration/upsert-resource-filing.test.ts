// DB integration test for topic filing T2b: upsertResource writes the filing decision as
// ResourceTopic memberships, in the same transaction as the row.
//
// This is the property that makes T2b mean anything at all — post-T1, retrieval is an
// EXISTS over "ResourceTopic", so a classifier verdict with no membership row is
// invisible no matter what Resource.topic says. Children matter most: they are the
// pickable leaves, so a missing membership there makes a whole decomposition unreachable.
//
// A decomposed container with one atomic child exercises both paths in one insert. No
// Vertex call: the child is embedded post-commit only if it has no supplied vector, so we
// keep the tree tiny and assert on memberships, not embeddings.
//
// Self-cleaning marker topics; skips cleanly without DATABASE_URL. Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { checkMembershipInvariants } from '@/lib/curation/resource-topics';
import { searchResources } from '@/lib/agents/tools/search-resources';
import type { FilingDecision } from '@/lib/curation/topic-knn';
import { describeDb } from './db';

const PRIMARY = '__verify_filing_primary__';
const SECONDARY = '__verify_filing_secondary__';
const CONTESTED = '__verify_filing_contested__';
const REQUEST = '__verify_filing_request__';
const URL = 'https://verify-filing.example.com/course';

const filing: FilingDecision = {
  primary: { topic: PRIMARY, relevance: 0.7, origin: 'classifier', contested: false },
  secondaries: [
    { topic: SECONDARY, relevance: 0.3, origin: 'classifier', contested: false },
    { topic: CONTESTED, relevance: 0.2, origin: 'classifier', contested: true },
  ],
  reason: 'classifier',
};

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: { in: [PRIMARY, SECONDARY, CONTESTED, REQUEST] } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: '__verify_filing' } } });
}

const membershipsOf = (resourceId: string) =>
  prisma.resourceTopic.findMany({
    where: { resourceId },
    select: { topic: true, relevance: true, origin: true, isPrimary: true, contested: true },
    orderBy: { topic: 'asc' },
  });

describeDb('upsertResource — filing decision becomes memberships (T2b)', () => {
  let parentId: string;
  let childId: string;
  let baseline: Awaited<ReturnType<typeof checkMembershipInvariants>>;

  beforeAll(async () => {
    await cleanup();
    // checkMembershipInvariants is WHOLE-TABLE by design (that scope is the property it
    // exists to verify), and this is the shared dev DB — sibling tests seed Resource rows
    // directly, without memberships. So assert this insert adds no NEW violation rather
    // than that the table is globally pristine.
    baseline = await checkMembershipInvariants();
    // The request topic is deliberately NOT the filed topic: the point of T2b is that a
    // row lands where it belongs, not where it was searched.
    const res = await upsertResource(
      REQUEST,
      {
        url: URL,
        title: 'A filed course',
        type: 'course',
        difficulty: 'beginner',
        durationMin: 60,
        summary: 'container',
        prerequisiteConcepts: [],
        conceptsTaught: [],
      },
      {
        status: 'decomposed',
        children: [
          {
            url: `${URL}/lesson-1`,
            title: 'Lesson 1',
            type: 'article',
            difficulty: 'beginner',
            durationMin: 15,
            summary: 'leaf',
            prerequisiteConcepts: [],
            conceptsTaught: [],
            orderInParent: 1,
          },
        ],
      },
      null, // no vector: keeps the post-commit embed out of this test
      filing,
    );
    parentId = res.resourceId!;
    [childId] = res.atomicIds;
    expect(res.outcome).toBe('inserted');
  });
  afterAll(cleanup);

  it('writes one primary plus the guarded secondaries, mirrored to Resource.topic', async () => {
    const rows = await membershipsOf(parentId);
    expect(rows.map((r) => r.topic)).toEqual([CONTESTED, PRIMARY, SECONDARY].sort());

    const primary = rows.find((r) => r.isPrimary)!;
    expect(primary).toMatchObject({ topic: PRIMARY, origin: 'classifier', contested: false });
    expect(primary.relevance).toBeCloseTo(0.7);
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);

    const mirror = await prisma.resource.findUniqueOrThrow({
      where: { id: parentId },
      select: { topic: true },
    });
    expect(mirror.topic).toBe(PRIMARY);
  });

  it('gives the child the parent’s filing, so the decomposition is retrievable', async () => {
    const rows = await membershipsOf(childId);
    expect(rows.map((r) => r.topic)).toEqual([CONTESTED, PRIMARY, SECONDARY].sort());
    expect(rows.find((r) => r.isPrimary)?.topic).toBe(PRIMARY);
  });

  it('adds no membership-invariant violation', async () => {
    const counts = await checkMembershipInvariants();
    expect(counts).toEqual(baseline);
  });

  it('is retrievable by its secondary topic but not by a contested secondary', async () => {
    const viaSecondary = await searchResources({ topics: [SECONDARY], statuses: ['pending_review'] });
    expect(viaSecondary.map((r) => r.id)).toContain(childId);

    const viaContested = await searchResources({ topics: [CONTESTED], statuses: ['pending_review'] });
    expect(viaContested.map((r) => r.id)).not.toContain(childId);
  });
});
