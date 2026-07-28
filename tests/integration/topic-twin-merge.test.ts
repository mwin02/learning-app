// DB integration test for topic filing T1.5's twin merge.
//
// Why this exists: on the dev DB both real twins hold ZERO resources and zero
// memberships, so an --apply run exercises only the alias branch. These synthetic twins
// drive the branches real data won't — primary + mirror, secondary, stranded scalar
// mirror, the Path/CourseRequest refusal, and idempotency — before the script is ever
// pointed at a database where those rows exist (e.g. Supabase after the D2 cutover).
//
// Self-cleaning: everything sits under __verify_twin__ topics/aliases. Skips cleanly
// with no DATABASE_URL. Run with the worker stopped.
import { beforeEach, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { planTwinMerge, applyTwinMerge } from '@/lib/curation/topic-twins';
import { describeDb } from './db';

const MARK = '__verify_twin__';
const FROM = `${MARK}from`;
const TO = `${MARK}to`;
const OTHER = `${MARK}other`; // stands in for an unrelated topic the merge must not touch

async function cleanup() {
  await prisma.path.deleteMany({ where: { topic: { in: [FROM, TO, OTHER] } } });
  await prisma.courseRequest.deleteMany({ where: { topic: { in: [FROM, TO, OTHER] } } });
  // By slug, not by topic: fixtures deliberately park rows under an unrelated topic too.
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.topicAlias.deleteMany({ where: { canonical: { in: [FROM, TO] } } });
}

async function makeResource(
  key: string,
  scalarTopic: string,
  memberships: { topic: string; isPrimary: boolean }[],
): Promise<string> {
  const source = await prisma.source.upsert({
    where: { slug: `${MARK}src` },
    update: {},
    create: { slug: `${MARK}src`, name: 'twin test source', url: 'https://example.com', kind: 'community' },
    select: { id: true },
  });
  const r = await prisma.resource.create({
    data: {
      topic: scalarTopic,
      slug: `${MARK}${key}`,
      title: `twin ${key}`,
      url: `${MARK}://${key}`,
      type: 'article',
      durationMin: 20,
      summary: 'seeded for the twin merge',
      difficulty: 'beginner',
      status: 'active',
      decompositionStatus: 'atomic',
      prerequisiteConcepts: [],
      conceptsTaught: [],
      sourceId: source.id,
      topics: { create: memberships },
    },
    select: { id: true },
  });
  return r.id;
}

describeDb('twin merge', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('repoints aliases, moves the primary, and drags the mirror with it', async () => {
    await prisma.topicAlias.create({
      data: { alias: `${MARK}phrasing`, canonical: FROM, subject: 'cs' },
    });
    const id = await makeResource('primary', FROM, [{ topic: FROM, isPrimary: true }]);

    const plan = await applyTwinMerge(FROM, TO);
    expect(plan.aliases).toBe(1);
    expect(plan.primaryMemberships).toBe(1);

    const alias = await prisma.topicAlias.findUnique({ where: { alias: `${MARK}phrasing` } });
    expect(alias?.canonical).toBe(TO);

    const memberships = await prisma.resourceTopic.findMany({
      where: { resourceId: id },
      select: { topic: true, isPrimary: true },
    });
    // The dead membership is gone, not merely superseded.
    expect(memberships).toEqual([{ topic: TO, isPrimary: true }]);

    const row = await prisma.resource.findUnique({ where: { id }, select: { topic: true } });
    expect(row?.topic).toBe(TO);
  });

  it('preserves filing evidence when moving a primary', async () => {
    const id = await makeResource('evidence', FROM, [{ topic: FROM, isPrimary: true }]);
    // `origin: 'inherited'` is deliberately NOT the schema default ('classifier'): a merge
    // renames a topic and gathers no evidence, so dropping origin on the way through
    // setPrimaryTopic would let the default apply and silently upgrade a T1 backfill row
    // to a classifier verdict nothing ever produced.
    await prisma.resourceTopic.updateMany({
      where: { resourceId: id, topic: FROM },
      data: { relevance: 0.62, origin: 'inherited', contested: true },
    });

    await applyTwinMerge(FROM, TO);

    const moved = await prisma.resourceTopic.findFirst({
      where: { resourceId: id },
      select: { topic: true, relevance: true, origin: true, contested: true },
    });
    expect(moved).toEqual({ topic: TO, relevance: 0.62, origin: 'inherited', contested: true });
  });

  it('moves a secondary membership without touching the primary or the mirror', async () => {
    const id = await makeResource('secondary', OTHER, [
      { topic: OTHER, isPrimary: true },
      { topic: FROM, isPrimary: false },
    ]);

    await applyTwinMerge(FROM, TO);

    const memberships = await prisma.resourceTopic.findMany({
      where: { resourceId: id },
      select: { topic: true, isPrimary: true },
      orderBy: { topic: 'asc' },
    });
    expect(memberships).toEqual([
      { topic: OTHER, isPrimary: true },
      { topic: TO, isPrimary: false },
    ]);
    const row = await prisma.resource.findUnique({ where: { id }, select: { topic: true } });
    expect(row?.topic).toBe(OTHER);
  });

  it('collapses a secondary onto an existing membership instead of duplicating it', async () => {
    const id = await makeResource('collapse', TO, [
      { topic: TO, isPrimary: true },
      { topic: FROM, isPrimary: false },
    ]);

    await applyTwinMerge(FROM, TO);

    const memberships = await prisma.resourceTopic.findMany({ where: { resourceId: id } });
    // @@unique([resourceId, topic]) would have thrown on a naive topic rewrite.
    expect(memberships).toHaveLength(1);
    expect(memberships[0].topic).toBe(TO);
    expect(memberships[0].isPrimary).toBe(true);
  });

  it('adopts a stranded scalar mirror that has no membership under the dead slug', async () => {
    const id = await makeResource('stranded', FROM, [{ topic: OTHER, isPrimary: true }]);
    // Simulate the pre-T1 shape: mirror says FROM, no membership says so.
    const plan = await planTwinMerge(FROM, TO);
    expect(plan.mirrorsOnly).toBe(1);

    await applyTwinMerge(FROM, TO);

    const row = await prisma.resource.findUnique({ where: { id }, select: { topic: true } });
    expect(row?.topic).toBe(TO);
    const primaries = await prisma.resourceTopic.findMany({
      where: { resourceId: id, isPrimary: true },
      select: { topic: true },
    });
    expect(primaries).toEqual([{ topic: TO }]);
  });

  it('refuses the merge while a Path still names the dead slug', async () => {
    await prisma.path.create({ data: { topic: FROM } });
    await makeResource('blocked', FROM, [{ topic: FROM, isPrimary: true }]);

    await expect(applyTwinMerge(FROM, TO)).rejects.toThrow(/refusing to merge/);

    // Nothing moved.
    const row = await prisma.resource.findFirst({
      where: { slug: `${MARK}blocked` },
      select: { topic: true },
    });
    expect(row?.topic).toBe(FROM);
  });

  it('is idempotent — a second run finds nothing and changes nothing', async () => {
    await prisma.topicAlias.create({
      data: { alias: `${MARK}phrasing`, canonical: FROM, subject: 'cs' },
    });
    await makeResource('idem', FROM, [{ topic: FROM, isPrimary: true }]);

    await applyTwinMerge(FROM, TO);
    const second = await applyTwinMerge(FROM, TO);

    expect(second).toMatchObject({
      aliases: 0,
      primaryMemberships: 0,
      secondaryMemberships: 0,
      mirrorsOnly: 0,
    });
  });

  // The same three properties checkMembershipInvariants() reports, but scoped to this
  // suite's rows. Deliberately NOT the global helper: that one is an ops check over the
  // whole table, so asserting it here would fail whenever another suite happens to hold a
  // membership-less fixture row — a property of the test run, not of the merge.
  it('leaves the T1 membership invariants intact for the rows it moved', async () => {
    const ids = [
      await makeResource('inv-primary', FROM, [{ topic: FROM, isPrimary: true }]),
      await makeResource('inv-secondary', OTHER, [
        { topic: OTHER, isPrimary: true },
        { topic: FROM, isPrimary: false },
      ]),
    ];

    await applyTwinMerge(FROM, TO);

    for (const id of ids) {
      const row = await prisma.resource.findUniqueOrThrow({
        where: { id },
        select: { topic: true, topics: { select: { topic: true, isPrimary: true } } },
      });
      const primaries = row.topics.filter((t) => t.isPrimary);
      expect(row.topics.length).toBeGreaterThan(0); // still reachable
      expect(primaries).toHaveLength(1); // exactly one primary
      expect(primaries[0].topic).toBe(row.topic); // mirror agrees
      expect(row.topics.map((t) => t.topic)).not.toContain(FROM); // dead slug gone
    }
  });
});
