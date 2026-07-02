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
});
