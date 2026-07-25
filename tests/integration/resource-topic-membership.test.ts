// DB integration test for topic filing T1: retrieval scopes on ResourceTopic memberships
// (many-to-many), not on the scalar Resource.topic mirror.
//
// Covers the two searchResources paths that spend no embedding — the fast path
// (count <= SEARCH_RANK_THRESHOLD) and the large-set-no-query path (seeded past the
// threshold with cheap filler rows). The ranked path and searchNearbyResources both call
// embedQuery, so per CLAUDE.md they stay out of Vitest and are exercised by the live
// driver scripts/verify-resource-topic-differential.ts instead.
//
// Self-cleaning: every row sits under a __verify_rt__ topic, deleted in before/after
// (ResourceTopic cascades with its Resource). Skips cleanly with no DATABASE_URL.
// Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { searchResources } from '@/lib/agents/tools/search-resources';
import { setPrimaryTopic } from '@/lib/curation/resource-topics';
import { SEARCH_RANK_THRESHOLD } from '@/lib/config';
import { describeDb } from './db';

const MARK = '__verify_rt__';
const ALPHA = `${MARK}alpha`;
const BETA = `${MARK}beta`;
const GAMMA = `${MARK}gamma`;

const ids: Record<string, string> = {};

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: { in: [ALPHA, BETA, GAMMA] } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

async function seed() {
  const source = await prisma.source.create({
    data: { slug: `${MARK}src`, name: 'T1 test source', url: 'https://example.com', kind: 'community' },
    select: { id: true },
  });
  const base = {
    type: 'article' as const,
    durationMin: 30,
    summary: 'seeded for topic filing T1',
    difficulty: 'beginner' as const,
    status: 'active' as const,
    decompositionStatus: 'atomic' as const,
    prerequisiteConcepts: [] as string[],
    conceptsTaught: [] as string[],
    sourceId: source.id,
  };
  const make = async (
    key: string,
    scalarTopic: string,
    memberships: { topic: string; isPrimary: boolean; contested?: boolean }[],
    trustScore = 0.5,
  ) => {
    const r = await prisma.resource.create({
      data: {
        ...base,
        topic: scalarTopic,
        slug: `${MARK}${key}`,
        title: `T1 ${key}`,
        url: `${MARK}://${key}`,
        trustScore,
        topics: { create: memberships },
      },
      select: { id: true },
    });
    ids[key] = r.id;
  };

  // Genuinely dual-topic: the case a scalar column cannot express. High trust so it
  // survives the large-set path's LIMIT window.
  await make('dual', ALPHA, [
    { topic: ALPHA, isPrimary: true },
    { topic: BETA, isPrimary: false },
    { topic: GAMMA, isPrimary: false },
  ], 0.99);
  // A contested SECONDARY is invisible to retrieval on that topic...
  await make('contestedSecondary', ALPHA, [
    { topic: ALPHA, isPrimary: true },
    { topic: BETA, isPrimary: false, contested: true },
  ]);
  // ...but a contested PRIMARY stays reachable — parking a doubt never orphans a row.
  await make('contestedPrimary', BETA, [{ topic: BETA, isPrimary: true, contested: true }]);
  // Scalar mirror says ALPHA, membership says GAMMA: proves the predicate reads the
  // membership table, not Resource.topic.
  await make('mirrorOnly', ALPHA, [{ topic: GAMMA, isPrimary: true }]);

  // Filler to push ALPHA past SEARCH_RANK_THRESHOLD so the large-set path is exercised.
  // Low trust so they rank below `dual` inside the LIMIT window.
  for (let i = 0; i < SEARCH_RANK_THRESHOLD + 1; i++) {
    await prisma.resource.create({
      data: {
        ...base,
        topic: ALPHA,
        slug: `${MARK}fill${i}`,
        title: `T1 filler ${i}`,
        url: `${MARK}://fill/${i}`,
        trustScore: 0.1,
        topics: { create: [{ topic: ALPHA, isPrimary: true }] },
      },
    });
  }
}

describeDb('searchResources — ResourceTopic membership', () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it('returns a dual-membership row exactly once on the fast path (two topics requested)', async () => {
    // BETA ∪ GAMMA is a handful of rows, so this takes the wholesale fast path — and
    // `dual` is a member of both requested topics.
    const rows = await searchResources({ topics: [BETA, GAMMA], statuses: ['active'] });
    expect(rows.length).toBeLessThanOrEqual(SEARCH_RANK_THRESHOLD);
    // The JOIN footgun would return this row twice — once per matching membership.
    expect(rows.filter((r) => r.id === ids.dual)).toHaveLength(1);
  });

  it('returns a dual-membership row exactly once on the large-set path (no query)', async () => {
    const rows = await searchResources({ topics: [ALPHA, BETA], statuses: ['active'] });
    expect(rows.length).toBeGreaterThan(SEARCH_RANK_THRESHOLD - 1);
    expect(rows.filter((r) => r.id === ids.dual)).toHaveLength(1);
  });

  it('finds a resource through a secondary membership', async () => {
    const rows = await searchResources({ topics: [BETA], statuses: ['active'] });
    expect(rows.map((r) => r.id)).toContain(ids.dual);
  });

  it('excludes a contested secondary but keeps a contested primary', async () => {
    const rows = await searchResources({ topics: [BETA], statuses: ['active'] });
    const got = rows.map((r) => r.id);
    expect(got).not.toContain(ids.contestedSecondary);
    expect(got).toContain(ids.contestedPrimary);
  });

  it('still returns a row whose contested secondary is on another requested topic', async () => {
    // contestedSecondary is contested under BETA but uncontested-primary under ALPHA:
    // the test is per-membership, so ALPHA still admits it.
    const rows = await searchResources({ topics: [ALPHA, BETA], statuses: ['active'], limit: 200 });
    expect(rows.map((r) => r.id)).toContain(ids.contestedSecondary);
  });

  it('scopes on membership, not on the scalar Resource.topic mirror', async () => {
    const onAlpha = await searchResources({ topics: [ALPHA], statuses: ['active'], limit: 200 });
    expect(onAlpha.map((r) => r.id)).not.toContain(ids.mirrorOnly);
    const onGamma = await searchResources({ topics: [GAMMA], statuses: ['active'] });
    expect(onGamma.map((r) => r.id)).toContain(ids.mirrorOnly);
  });
});

// Kept last: these mutate `dual`'s primary, which the retrieval cases above rely on.
describeDb('setPrimaryTopic — the mirror write seam', () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it('leaves exactly one primary and a matching mirror after a refile', async () => {
    await setPrimaryTopic(ids.dual, BETA, { origin: 'review', relevance: 0.8 });

    const memberships = await prisma.resourceTopic.findMany({
      where: { resourceId: ids.dual },
      select: { topic: true, isPrimary: true, origin: true, relevance: true },
    });
    expect(memberships.filter((m) => m.isPrimary).map((m) => m.topic)).toEqual([BETA]);
    // Promotion updates the existing membership in place — no duplicate row (dual is
    // seeded with three memberships: ALPHA, BETA, GAMMA).
    expect(memberships).toHaveLength(3);

    const row = await prisma.resource.findUnique({
      where: { id: ids.dual },
      select: { topic: true },
    });
    expect(row?.topic).toBe(BETA);

    const promoted = memberships.find((m) => m.topic === BETA);
    expect(promoted?.origin).toBe('review');
    expect(promoted?.relevance).toBe(0.8);
  });

  it('creates the membership when filing under a topic the resource has never had', async () => {
    await setPrimaryTopic(ids.contestedPrimary, GAMMA, { origin: 'classifier' });

    const memberships = await prisma.resourceTopic.findMany({
      where: { resourceId: ids.contestedPrimary },
      select: { topic: true, isPrimary: true },
    });
    expect(memberships).toHaveLength(2);
    expect(memberships.filter((m) => m.isPrimary).map((m) => m.topic)).toEqual([GAMMA]);
    const row = await prisma.resource.findUnique({
      where: { id: ids.contestedPrimary },
      select: { topic: true },
    });
    expect(row?.topic).toBe(GAMMA);
  });

  it('leaves fields the caller did not supply untouched on an existing membership', async () => {
    // dual's ALPHA membership was created by seed() with the schema defaults.
    await setPrimaryTopic(ids.dual, ALPHA);
    const alpha = await prisma.resourceTopic.findFirst({
      where: { resourceId: ids.dual, topic: ALPHA },
      select: { relevance: true, origin: true, isPrimary: true },
    });
    expect(alpha).toMatchObject({ isPrimary: true, relevance: 1.0, origin: 'classifier' });
  });

  it('throws on an unknown resource rather than silently writing nothing', async () => {
    await expect(setPrimaryTopic('no-such-resource-id', ALPHA)).rejects.toThrow(/not found/);
  });
});
