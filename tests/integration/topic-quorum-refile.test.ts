// DB integration test for topic filing T4b — the quorum seed/mint pass.
//
// The decision matrix is pure and covered in src/lib/curation/quorum-refile.test.ts.
// What can only be proven against Postgres is the property the whole block leans on and
// that no pure test can see, because it is a behaviour of `setPrimaryTopic` rather than
// of any decision: MOVING A PRIMARY LEAVES THE VACATED TOPIC BEHIND AS AN UNCONTESTED
// SECONDARY. That is what keeps `probability-and-statistics`' live Path whole while 254
// of its rows move to `statistics`, and it is what supplies T4d's precondition.
//
// Self-cleaning marker topics; skips cleanly without DATABASE_URL. Run with the worker
// stopped (the membership tables are shared with the compose workers).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import {
  setPrimaryTopic,
  applyReclassification,
  settleMembership,
  checkMembershipInvariants,
} from '@/lib/curation/resource-topics';
import { decideRefile, type RefileRecord } from '@/lib/curation/quorum-refile';
import { describeDb } from './db';

const FROM = '__verify_t4b_from__';
const TO = '__verify_t4b_to__';

let resourceId = '';
let baseline: Awaited<ReturnType<typeof checkMembershipInvariants>>;

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: { in: [FROM, TO] } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: FROM } } });
}

async function membershipsOf(id: string) {
  return prisma.resourceTopic.findMany({
    where: { resourceId: id },
    select: { topic: true, relevance: true, origin: true, contested: true, isPrimary: true },
    orderBy: { topic: 'asc' },
  });
}

// A row in exactly the state T4a leaves an `unvouchable-pool` verdict in: one primary,
// re-scored to a MEASURED purity, origin flipped off `inherited`, and uncontested —
// because that verdict is a vocabulary signal, not doubt about the row.
const record: RefileRecord = {
  id: '',
  title: 'Worked example: Evaluating functions from equation',
  currentTopic: FROM,
  relevance: 0.9,
  unvouchable: TO,
  newTopic: null,
};

describeDb('topic filing T4b — quorum refile DB seams', () => {
  beforeAll(async () => {
    await cleanup();
    // checkMembershipInvariants is WHOLE-TABLE by design (that scope is the property it
    // exists to verify), and this is the shared dev DB — sibling tests seed Resource rows
    // directly, without memberships. So assert these writes add no NEW violation rather
    // than that the table is globally pristine.
    baseline = await checkMembershipInvariants();
    const source = await prisma.source.create({
      data: {
        slug: `${FROM}src`,
        name: 'Quorum refile source',
        url: 'https://verify-t4b.example.com',
        kind: 'community',
      },
      select: { id: true },
    });
    const r = await prisma.resource.create({
      data: {
        slug: `${FROM}row`,
        topic: FROM,
        title: record.title,
        url: 'https://verify-t4b.example.com/row',
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
    resourceId = r.id;
    await setPrimaryTopic(r.id, FROM, { origin: 'classifier', relevance: 0.9, contested: false });
  });

  afterAll(cleanup);

  it('moves the primary onto the target and mirrors it', async () => {
    const decision = decideRefile({ ...record, id: resourceId }, TO);
    expect(typeof decision).toBe('object');
    await applyReclassification(resourceId, decision as Exclude<typeof decision, string>);

    const rows = await membershipsOf(resourceId);
    expect(rows.filter((m) => m.isPrimary)).toMatchObject([
      { topic: TO, relevance: 0, origin: 'classifier', contested: true },
    ]);
    const resource = await prisma.resource.findUniqueOrThrow({
      where: { id: resourceId },
      select: { topic: true },
    });
    expect(resource.topic).toBe(TO);
  });

  it('RETAINS the vacated topic as an uncontested secondary, with its measured relevance', async () => {
    // The property the block's reachability argument rests on. If this ever regresses,
    // every refile silently strips the vacated shelf — a live Path would lose the rows
    // in the same move that gives the new shelf its pool.
    const rows = await membershipsOf(resourceId);
    expect(rows).toHaveLength(2);
    expect(rows.find((m) => m.topic === FROM)).toMatchObject({
      isPrimary: false,
      contested: false,
      relevance: 0.9,
      origin: 'classifier',
    });
  });

  it('settles only the named membership, leaving the retained secondary untouched', async () => {
    await settleMembership(resourceId, TO, { relevance: 0.7, contested: false });
    const rows = await membershipsOf(resourceId);
    expect(rows.find((m) => m.topic === TO)).toMatchObject({ relevance: 0.7, contested: false });
    expect(rows.find((m) => m.topic === FROM)).toMatchObject({ relevance: 0.9, contested: false });
  });

  it('is a no-op on a membership that is not there', async () => {
    // Phase 2 runs across hundreds of rows at the end of a long pass; a membership that
    // vanished under it must not abort the remaining settlements.
    await expect(
      settleMembership(resourceId, '__verify_t4b_absent__', { relevance: 1, contested: false }),
    ).resolves.toBeUndefined();
    expect(await membershipsOf(resourceId)).toHaveLength(2);
  });

  it('is idempotent — re-refiling the row it already moved changes nothing', async () => {
    // The driver's live-drift guard is what normally stops a re-run, but the write half
    // has to be safe on its own: `already-filed` is a skip, not a second move.
    expect(decideRefile({ ...record, id: resourceId, currentTopic: TO }, TO)).toBe('already-filed');
  });

  it('adds no new T1 membership-invariant violation', async () => {
    expect(await checkMembershipInvariants()).toEqual(baseline);
  });
});
