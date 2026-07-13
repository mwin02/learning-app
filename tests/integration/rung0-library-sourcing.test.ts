// DB integration test for Block 4 rung-0 library-first sourcing: a hole concept
// whose topic library already holds enough embedded, semantically-near atomic
// rows gets them judged and attached with ZERO web-discovery iterations — the
// library rung fills targetCount, so the discover/validate ladder never runs.
//
// LLM leaves are mocked (no tokens, deterministic):
//   - embedQuery → fixed unit vector, matching the hand-written row embeddings
//     (distance 0, under the ceiling);
//   - judgeCandidates keeps everything as `teaches` @ 0.9;
//   - the YouTube prong is a spy returning [] — zero calls proves discovery was
//     skipped, calls prove the ladder ran (the shortfall re-run case);
//   - the ai SDK's generateText/generateObject return empty (the grounded
//     prongs discover nothing on the shortfall run).
// searchNearbyResources (pgvector SQL), the attach transaction,
// promote-on-attach, and recomputeReadiness run for real against the dev DB.
//
// Self-cleaning: rows use a __verify_rung0__ marker. Skips without DATABASE_URL.
import { beforeAll, afterAll, it, expect, vi } from 'vitest';

vi.mock('@/lib/ai/embeddings', () => ({
  buildEmbeddingText: (r: { title: string }) => r.title,
  embedTexts: async () => {
    throw new Error('embedTexts should not be called');
  },
  embedQuery: async () => unitVec(0),
  embedMissing: async () => 0,
  safeEmbedResource: async () => {},
}));

vi.mock('@/lib/agents/map/candidate-judge', () => ({
  judgeCandidates: async ({ candidates }: { candidates: { id: string; trustScore: number; durationMin: number }[] }) =>
    candidates.map((c) => ({
      resourceId: c.id,
      role: 'teaches',
      coverageScore: 0.9,
      trustScore: c.trustScore,
      durationMin: c.durationMin,
    })),
}));

const youtubeProng = vi.fn(async (_args?: unknown) => []);
vi.mock('@/lib/agents/tools/youtube-search', () => ({
  searchYouTubeForConcept: (args: unknown) => youtubeProng(args),
}));

// Empty out the grounded discovery calls (real module otherwise — `tool` etc.).
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: async () => ({
    text: '```json\n[]\n```',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    sources: [],
    finishReason: 'stop',
  }),
  generateObject: async () => ({ object: { results: [] } }),
}));

import { prisma } from '@/lib/db';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';
import { describeDb } from './db';

const TOPIC = '__verify_rung0__';

function unitVec(i: number): number[] {
  const v = new Array(768).fill(0);
  v[i] = 1;
  return v;
}

let pathId: string;
let conceptId: string;
let libraryIds: string[] = [];

async function cleanup() {
  // Path first: cascades concepts → their ConceptResource links, which
  // otherwise block the resource deletes.
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
}

describeDb('rung 0 — library-first sourcing', () => {
  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${TOPIC}src`, name: 'rung0 source', url: 'https://verify-rung0.example.com', kind: 'community' },
      select: { id: true },
    });
    const path = await prisma.path.create({
      data: { topic: TOPIC, concepts: { create: [{ slug: 'rung0-alpha', title: 'Alpha subject' }] } },
      select: { id: true, concepts: { select: { id: true } } },
    });
    pathId = path.id;
    conceptId = path.concepts[0].id;

    // Three embedded, semantically-matching atomic library rows — exactly the
    // default REMEDIATION_SOURCE_TARGET_COUNT, so rung 0 fills the target.
    // pending_review on purpose: attach must promote them.
    for (let i = 0; i < 3; i++) {
      const row = await prisma.resource.create({
        data: {
          slug: `${TOPIC}row${i}`,
          topic: TOPIC,
          title: `Alpha lesson ${i}`,
          url: `https://verify-rung0.example.com/${i}`,
          type: 'article',
          durationMin: 25,
          summary: `Alpha lesson ${i}`,
          difficulty: 'beginner',
          prerequisiteConcepts: [],
          conceptsTaught: [],
          status: 'pending_review',
          sourceId: source.id,
        },
        select: { id: true },
      });
      libraryIds.push(row.id);
      await prisma.$executeRawUnsafe(
        `UPDATE "Resource" SET embedding = '[${unitVec(0).join(',')}]'::vector WHERE id = '${row.id}'`,
      );
    }
  });
  afterAll(cleanup);

  it('fills the hole from the library with zero discovery iterations', async () => {
    const attached = await sourceAndAttachConcept({
      pathId,
      topic: TOPIC,
      conceptId,
      slug: 'rung0-alpha',
      title: 'Alpha subject',
    });
    expect(attached).toBe(3);

    const links = await prisma.conceptResource.findMany({
      where: { conceptId },
      select: { resourceId: true, role: true },
    });
    expect(links.map((l) => l.resourceId).sort()).toEqual([...libraryIds].sort());

    // Nothing was web-sourced: no prong was ever invoked and the topic's
    // resource count is unchanged.
    expect(youtubeProng).not.toHaveBeenCalled();
    expect(await prisma.resource.count({ where: { topic: TOPIC } })).toBe(3);
  });

  it('promote-on-attach flipped the pending_review library rows to active', async () => {
    const rows = await prisma.resource.findMany({
      where: { id: { in: libraryIds } },
      select: { status: true },
    });
    expect(rows.map((r) => r.status)).toEqual(['active', 'active', 'active']);
  });

  it('a re-run excludes the attached rows and owes the web the full shortfall (no double-count)', async () => {
    // All 3 matches are now attached → rung 0 excludes them → shortfall 3 → the
    // ladder DOES run this time (prongs mocked to empty), attaching nothing.
    const attached = await sourceAndAttachConcept({
      pathId,
      topic: TOPIC,
      conceptId,
      slug: 'rung0-alpha',
      title: 'Alpha subject',
    });
    expect(attached).toBe(0);
    expect(youtubeProng).toHaveBeenCalled();
    expect(await prisma.conceptResource.count({ where: { conceptId } })).toBe(3);
  });
});
