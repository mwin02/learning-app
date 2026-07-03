// DB integration test for F8: upsertResource dedups on the canonical URL, so a
// trivially-different variant of an already-stored page collapses onto the existing row
// instead of inserting a duplicate.
//
// The canonical row is seeded directly (no upsertResource), so the variant call hits the
// URL-keyed skip path and returns BEFORE any embed/classify call — no LLM, no Vertex.
//
// Self-cleaning: rows use a verify-f8 marker, deleted in before/after.
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { describeDb } from './db';

const TOPIC = '__verify_f8__';
const CANONICAL = 'https://verify-f8.example.com/calc/series';

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
}

const atomic = { status: 'atomic' as const, children: [] };
const input = (url: string) => ({
  url,
  title: 'Calculus II — Series',
  type: 'article',
  difficulty: 'beginner',
  durationMin: 180,
  summary: 'series',
  prerequisiteConcepts: [] as string[],
  conceptsTaught: [] as string[],
});

const countCanonical = () => prisma.resource.count({ where: { url: CANONICAL } });

describeDb('upsertResource — canonical-URL dedup', () => {
  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${TOPIC}src`, name: 'F8 source', url: 'https://verify-f8.example.com', kind: 'community' },
      select: { id: true },
    });
    // Seed the canonical row directly (no embeds) so the variant hits the skip path.
    await prisma.resource.create({
      data: {
        slug: `${TOPIC}canonical`,
        topic: TOPIC,
        title: 'Calculus II — Series',
        url: CANONICAL,
        type: 'article',
        durationMin: 180,
        summary: 'series',
        difficulty: 'beginner',
        prerequisiteConcepts: [],
        conceptsTaught: [],
        sourceId: source.id,
      },
    });
  });
  afterAll(cleanup);

  it('skips a variant URL (host case + trailing slash + tracking param + fragment) as a dup', async () => {
    const variant = 'https://Verify-F8.example.com/calc/series/?utm_source=newsletter#top';
    const res = await upsertResource(TOPIC, input(variant), atomic);
    expect(res.outcome).toBe('skipped');
    expect(await countCanonical()).toBe(1); // no duplicate row inserted
  });

  it('skips the exact canonical URL too', async () => {
    const res = await upsertResource(TOPIC, input(CANONICAL), atomic);
    expect(res.outcome).toBe('skipped');
    expect(await countCanonical()).toBe(1);
  });
});
