// DB integration test: caching a resource's embeddability must NOT bump `updatedAt`.
//
// `Resource.updatedAt` is @updatedAt, and embedMissing() reads `embeddedAt < updatedAt`
// as "content changed, re-embed me". safeClassifyAndPersist runs immediately after the
// embed on every insert path, so writing through prisma.resource.update marked every
// freshly-inserted row stale on arrival — measured 2026-07-25 as a backfill re-embedding
// 1,914 of 1,929 rows with nothing changed. `embeddable` is a property of the URL, not
// of the embedded text.
//
// A youtube.com URL hits the embed allowlist and short-circuits before the HEAD probe,
// so this costs no network call.
//
// Self-cleaning marker topic; skips cleanly without DATABASE_URL. Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { safeClassifyAndPersist } from '@/lib/curation/embeddability';
import { describeDb } from './db';

const TOPIC = '__verify_embeddability__';
const URL = 'https://www.youtube.com/watch?v=verify-embeddability';

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
}

describeDb('safeClassifyAndPersist — does not touch updatedAt', () => {
  let resourceId: string;

  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${TOPIC}src`, name: 'Embeddability source', url: 'https://www.youtube.com', kind: 'community' },
      select: { id: true },
    });
    const r = await prisma.resource.create({
      data: {
        slug: `${TOPIC}row`,
        topic: TOPIC,
        title: 'A video',
        url: URL,
        type: 'video',
        durationMin: 12,
        summary: 'video',
        difficulty: 'beginner',
        prerequisiteConcepts: [],
        conceptsTaught: [],
        sourceId: source.id,
      },
      select: { id: true },
    });
    resourceId = r.id;
  });
  afterAll(cleanup);

  it('caches the verdict while leaving updatedAt untouched', async () => {
    const before = await prisma.resource.findUniqueOrThrow({
      where: { id: resourceId },
      select: { updatedAt: true },
    });

    const verdict = await safeClassifyAndPersist(resourceId, URL);
    expect(verdict).toBe(true); // allowlisted host, no network probe

    const after = await prisma.resource.findUniqueOrThrow({
      where: { id: resourceId },
      select: { updatedAt: true, embeddable: true, embedCheckedAt: true },
    });
    expect(after.embeddable).toBe(true);
    expect(after.embedCheckedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
