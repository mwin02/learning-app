// DB integration test for topic filing T2b: upsertResource writes the filing decision as
// ResourceTopic memberships, in the same transaction as the row.
//
// This is the property that makes T2b mean anything at all — post-T1, retrieval is an
// EXISTS over "ResourceTopic", so a classifier verdict with no membership row is
// invisible no matter what Resource.topic says. Children matter most: they are the
// pickable leaves, so a missing membership there makes a whole decomposition unreachable.
//
// A decomposed container with one atomic child exercises both paths in one insert, and a
// separate ATOMIC row carries the injected filing verbatim into retrieval.
//
// ⚠️ UPDATED FOR Q4 (2026-08-12). This file used to assert that a container's `filing`
// argument propagated verbatim to its children. Q4 deliberately reversed that: a child is
// classified on its OWN content before the transaction opens (`fileChildren`), and the
// parent's topic survives only as the prior/fallback that `decideFilingWithParentPrior`
// may never use to move a child between shelves. The old assertion was pre-Q4 behaviour;
// what replaces it is the property Q4 actually established — see the child test below.
//
// The child path calls the live classifier and embedder, so this file is NOT free: keep
// the tree at one child, and never assert on WHICH shelf the child lands on. The marker
// topics below are not canonical vocabulary, so the classifier can only ever propose real
// canonicals or nothing, and the branch `decideFiling` takes depends on a live k-NN
// neighbourhood. Assertions here are the ones that hold whichever branch fires.
//
// Self-cleaning marker topics; skips cleanly without DATABASE_URL. Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { checkMembershipInvariants } from '@/lib/curation/resource-topics';
import { searchResources } from '@/lib/agents/tools/search-resources';
import { listCanonicals } from '@/lib/agents/topic-registry';
import type { FilingDecision } from '@/lib/curation/topic-knn';
import { describeDb } from './db';

const PRIMARY = '__verify_filing_primary__';
const SECONDARY = '__verify_filing_secondary__';
const CONTESTED = '__verify_filing_contested__';
const REQUEST = '__verify_filing_request__';
const URL = 'https://verify-filing.example.com/course';
const ATOMIC_URL = 'https://verify-filing.example.com/single-lesson';

const filing: FilingDecision = {
  primary: { topic: PRIMARY, relevance: 0.7, origin: 'classifier', contested: false },
  secondaries: [
    { topic: SECONDARY, relevance: 0.3, origin: 'classifier', contested: false },
    { topic: CONTESTED, relevance: 0.2, origin: 'classifier', contested: true },
  ],
  reason: 'classifier',
};

// ⚠️ Deletes by URL as well as by marker topic. Post-Q4 the child is filed on its own
// content, so it can land on a REAL canonical topic — a topic-only cleanup would then
// strand it in the shared dev DB, mis-shelved and permanent. The URL prefix is the only
// identifier this fixture controls end to end.
async function cleanup() {
  await prisma.resource.deleteMany({
    where: {
      OR: [
        { topic: { in: [PRIMARY, SECONDARY, CONTESTED, REQUEST] } },
        { url: { startsWith: 'https://verify-filing.example.com' } },
      ],
    },
  });
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
  let atomicId: string;
  let canonicals: string[];
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
        durationSource: 'estimated' as const,
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
            durationSource: 'estimated' as const,
            summary: 'leaf',
            prerequisiteConcepts: [],
            conceptsTaught: [],
            conceptOrigin: 'derived',
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

    // An ATOMIC row takes the injected filing verbatim — no children, so `fileChildren`
    // never runs and nothing re-decides it. This is the row the retrieval assertions need:
    // post-Q4 no child is guaranteed to carry a secondary, and a `decomposed` container is
    // excluded from search by the pickability predicate, so neither could carry them.
    const single = await upsertResource(
      REQUEST,
      {
        url: ATOMIC_URL,
        title: 'A filed lesson',
        type: 'article',
        difficulty: 'beginner',
        durationMin: 15,
        durationSource: 'estimated' as const,
        summary: 'leaf',
        prerequisiteConcepts: [],
        conceptsTaught: [],
      },
      { status: 'atomic', children: [] },
      null,
      filing,
    );
    atomicId = single.resourceId!;
    expect(single.outcome).toBe('inserted');

    canonicals = await listCanonicals();
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

  // Q4 (plan defect P3): a child is filed on its own content, and the parent's filing is
  // NOT copied down. Two things are asserted, and neither depends on which branch of
  // `decideFiling` the live evidence takes:
  //
  //   - the child is filed SOMEWHERE, with exactly one primary, mirrored — the property
  //     this file exists for. A child with no membership is an unreachable decomposition.
  //   - its memberships are its own: the parent's secondaries never appear on it. Those
  //     two marker topics are outside the canonical vocabulary and are not the request
  //     topic, so the ONLY way either could reach this row is the pre-Q4 copy.
  //
  // What the child's primary may be is deliberately left open: the parent's topic when the
  // classifier finds no vouchable home (the fallback that makes the parent a prior rather
  // than an answer — the observed outcome for this fixture), or a canonical topic when the
  // neighbourhood vouches for one. Pinning either would be pinning a live model's verdict.
  it('files the child on its own content, never by copying the parent’s filing', async () => {
    const rows = await membershipsOf(childId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);

    expect(rows.map((r) => r.topic)).not.toContain(SECONDARY);
    expect(rows.map((r) => r.topic)).not.toContain(CONTESTED);
    for (const row of rows) {
      expect([PRIMARY, ...canonicals]).toContain(row.topic);
    }

    const mirror = await prisma.resource.findUniqueOrThrow({
      where: { id: childId },
      select: { topic: true },
    });
    expect(mirror.topic).toBe(rows.find((r) => r.isPrimary)?.topic);
  });

  it('adds no membership-invariant violation', async () => {
    const counts = await checkMembershipInvariants();
    expect(counts).toEqual(baseline);
  });

  // The uncertainty rule in searchResources — `(isPrimary OR NOT contested)` — asserted
  // end to end, from the filing decision through the membership write to retrieval.
  // Asserted on the atomic row rather than the child: this is a property of what a filing
  // decision does, and post-Q4 the atomic row is the one whose memberships ARE that
  // decision.
  it('is retrievable by its secondary topic but not by a contested secondary', async () => {
    const viaSecondary = await searchResources({ topics: [SECONDARY], statuses: ['pending_review'] });
    expect(viaSecondary.map((r) => r.id)).toContain(atomicId);

    const viaContested = await searchResources({ topics: [CONTESTED], statuses: ['pending_review'] });
    expect(viaContested.map((r) => r.id)).not.toContain(atomicId);

    // ...and the primary always admits the row, contested or not.
    const viaPrimary = await searchResources({ topics: [PRIMARY], statuses: ['pending_review'] });
    expect(viaPrimary.map((r) => r.id)).toContain(atomicId);
  });
});
