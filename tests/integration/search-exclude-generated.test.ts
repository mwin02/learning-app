// DB integration test for F6: searchResources({ excludeGenerated: true }) keeps
// origin=generated on-ramp rows out of the ordinary candidate search, while the
// default (other callers) still returns them. No LLM — no `query` is passed, so
// searchResources takes the fast trustScore-ordered path with no embedding.
//
// Self-cleaning: rows use a __verify_f6__ marker, deleted in before/after.
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { searchResources } from '@/lib/agents/tools/search-resources';
import { checkMembershipInvariants } from '@/lib/curation/resource-topics';
import { describeDb } from './db';

const MARK = '__verify_f6__';

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: MARK } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

async function seed() {
  const source = await prisma.source.create({
    data: { slug: `${MARK}src`, name: 'F6 test source', url: 'https://example.com', kind: 'community' },
    select: { id: true },
  });
  const base = {
    topic: MARK,
    // Topic filing T1: searchResources scopes on ResourceTopic membership, not on the
    // scalar mirror — a fixture row without one is invisible to it.
    topics: { create: [{ topic: MARK, isPrimary: true, origin: 'inherited' as const }] },
    type: 'article' as const,
    durationMin: 30,
    summary: 'seeded for F6',
    difficulty: 'beginner' as const,
    status: 'active' as const,
    decompositionStatus: 'atomic' as const,
    prerequisiteConcepts: [] as string[],
    conceptsTaught: [] as string[],
    sourceId: source.id,
  };
  await prisma.resource.create({
    data: { ...base, slug: `${MARK}sourced`, title: 'Sourced article', url: `${MARK}://sourced`, origin: 'agent' },
  });
  await prisma.resource.create({
    data: { ...base, slug: `${MARK}generated`, title: 'Generated on-ramp', url: `generated://${MARK}/onramp`, origin: 'generated' },
  });
}

describeDb('searchResources — excludeGenerated', () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it('returns both rows by default (unchanged for other callers)', async () => {
    const rows = await searchResources({ topics: [MARK], statuses: ['active'] });
    expect(rows.map((r) => r.slug).sort()).toEqual([`${MARK}generated`, `${MARK}sourced`]);
  });

  it('drops the generated row when excludeGenerated is set', async () => {
    const rows = await searchResources({ topics: [MARK], statuses: ['active'], excludeGenerated: true });
    expect(rows.map((r) => r.slug)).toEqual([`${MARK}sourced`]);
    expect(rows.some((r) => r.slug === `${MARK}generated`)).toBe(false);
  });

  // Q7/P5 REVERSED HALF OF THE OLD SCOPING RULE, and this is the regression guard for the
  // new half. The three LIBRARY counts still exclude generated rows — an on-ramp lesson
  // belongs to one concept of one Path, never to a topic's shelf, which is why this search
  // filter exists. But a generated row carrying a scalar `Resource.topic` with NO
  // membership behind it is now a detected error rather than an invisible one: that hole
  // (8 rows, measured 2026-08-11) is the mirror rotting, and generateOnRampResource now
  // writes the membership through setPrimaryTopic in the same transaction as the row.
  it('counts a membership-less generated row as unfiledGenerated, not as a library hole', async () => {
    const before = await checkMembershipInvariants();
    const source = await prisma.source.findFirstOrThrow({ where: { slug: `${MARK}src` }, select: { id: true } });
    const bare = await prisma.resource.create({
      data: {
        topic: MARK,
        slug: `${MARK}bare-onramp`,
        title: 'Generated on-ramp with no membership',
        url: `generated://${MARK}/bare`,
        origin: 'generated',
        type: 'article',
        durationMin: 30,
        summary: 'seeded for the invariant scope',
        difficulty: 'beginner',
        status: 'active',
        decompositionStatus: 'atomic',
        prerequisiteConcepts: [],
        conceptsTaught: [],
        sourceId: source.id,
      },
      select: { id: true, topics: { select: { id: true } } },
    });
    expect(bare.topics).toHaveLength(0); // the shape generateOnRampResource used to produce
    const after = await checkMembershipInvariants();
    expect(after).toEqual({
      noMembership: before.noMembership,
      badPrimaryCount: before.badPrimaryCount,
      mirrorDrift: before.mirrorDrift,
      unfiledGenerated: before.unfiledGenerated + 1,
    });
  });
});
