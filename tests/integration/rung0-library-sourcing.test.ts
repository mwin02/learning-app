// DB integration test for rung-0 library-first sourcing, on the rung0-starvation
// R1 contract: the web budget is spent on rung-0 candidates that SURVIVED the
// judge, not on raw search hits.
//
//   - library candidates all kept        → target filled → ZERO web discovery
//   - library candidates all judged away → full web budget (the R1 fix; pre-R1
//     three raw hits zeroed the budget forever)
//   - library candidates kept as `uses`  → numerically full but no qualifying
//     primary → requirePrimary floors the budget at 1; without it, no web call
//
// …and the R2 rejection memory layered on top of the judged-away case: the drops
// are recorded per concept, a later run excludes them from rung 0 entirely (so a
// verdict that WOULD keep them never gets the chance), and either filing-repair
// cause — a T4a re-score or a T4b quorum refile — clears the touched row's
// rejections while its siblings stay remembered. Both causes commit through the one
// `applyReclassification` seam, so the two cases differ only in the decision fed to it.
//
// Every case uses its OWN concept (the rows match every concept — one fixed query
// vector — but the attached-row exclusion is per concept, so the cases don't leak
// into each other).
//
// LLM leaves are mocked (no tokens, deterministic):
//   - embedQuery → fixed unit vector, matching the hand-written row embeddings
//     (distance 0, under the ceiling);
//   - judgeCandidates is driven by `judgeVerdict`, per test;
//   - the YouTube prong is a spy returning [] — zero calls proves discovery was
//     skipped, calls prove the ladder ran;
//   - the ai SDK's generateText/generateObject return empty (the grounded
//     prongs discover nothing when the ladder does run).
// searchNearbyResources (pgvector SQL), the attach transaction,
// promote-on-attach, and recomputeReadiness run for real against the dev DB.
//
// Self-cleaning: rows use a __verify_rung0__ marker. Skips without DATABASE_URL.
import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';

vi.mock('@/lib/ai/embeddings', () => ({
  buildEmbeddingText: (r: { title: string }) => r.title,
  embedTexts: async () => {
    throw new Error('embedTexts should not be called');
  },
  embedQuery: async () => unitVec(0),
  embedMissing: async () => 0,
  safeEmbedResource: async () => {},
}));

// Per-test judge verdict. `teaches` @ 0.9 attaches as a qualifying primary; `uses`
// @ 0.9 attaches but closes no hole; 0.1 is under MAP_ATTACH_MIN_COVERAGE, so
// nothing attaches at all.
let judgeVerdict: { role: 'teaches' | 'uses'; coverageScore: number } = { role: 'teaches', coverageScore: 0.9 };
vi.mock('@/lib/agents/map/candidate-judge', () => ({
  judgeCandidates: async ({ candidates }: { candidates: { id: string; trustScore: number; durationMin: number }[] }) =>
    candidates.map((c) => ({
      resourceId: c.id,
      ...judgeVerdict,
      trustScore: c.trustScore,
      durationMin: c.durationMin,
    })),
}));

const youtubeProng = vi.fn(async () => []);
vi.mock('@/lib/agents/tools/youtube-search', () => ({
  searchYouTubeForConcept: () => youtubeProng(),
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
import { applyReclassification } from '@/lib/curation/resource-topics';
import { decideRefile } from '@/lib/curation/quorum-refile';
import { describeDb } from './db';

const TOPIC = '__verify_rung0__';
// Where the T4b refile case moves its row. Shares TOPIC's prefix so cleanup still
// reaches it — the fixture rows no longer all live under one topic.
const MOVED_TOPIC = `${TOPIC}moved`;

function unitVec(i: number): number[] {
  const v = new Array(768).fill(0);
  v[i] = 1;
  return v;
}

const CONCEPTS = ['rung0-alpha', 'rung0-beta', 'rung0-gamma', 'rung0-delta'] as const;

let pathId: string;
const conceptIds = new Map<string, string>();
const libraryIds: string[] = [];

async function cleanup() {
  // Path first: cascades concepts → their ConceptResource links, which
  // otherwise block the resource deletes.
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  // startsWith, not equals: the T4b refile case moves a fixture row to MOVED_TOPIC,
  // and an exact match would leak it (and its memberships) into the dev DB.
  await prisma.resource.deleteMany({ where: { topic: { startsWith: TOPIC } } });
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
      data: {
        topic: TOPIC,
        concepts: { create: CONCEPTS.map((slug) => ({ slug, title: `${slug} subject` })) },
      },
      select: { id: true, concepts: { select: { id: true, slug: true } } },
    });
    pathId = path.id;
    for (const c of path.concepts) conceptIds.set(c.slug, c.id);

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
          // Topic filing T1: retrieval scopes on ResourceTopic membership, not on the
          // scalar mirror — a fixture row without one is invisible to searchResources.
          topics: { create: [{ topic: TOPIC, isPrimary: true, origin: 'inherited' }] },
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

  beforeEach(() => {
    judgeVerdict = { role: 'teaches', coverageScore: 0.9 };
    youtubeProng.mockClear();
  });

  // The concept under test in each case; `title` drives the (mocked) query embed.
  function sourceFor(slug: string, requirePrimary: boolean) {
    return sourceAndAttachConcept({
      pathId,
      topic: TOPIC,
      conceptId: conceptIds.get(slug)!,
      slug,
      title: `${slug} subject`,
      requirePrimary,
    });
  }

  it('fills the hole from the library with zero discovery iterations', async () => {
    const attached = await sourceFor('rung0-alpha', true);
    expect(attached).toBe(3);

    const links = await prisma.conceptResource.findMany({
      where: { conceptId: conceptIds.get('rung0-alpha') },
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
    const attached = await sourceFor('rung0-alpha', true);
    expect(attached).toBe(0);
    expect(youtubeProng).toHaveBeenCalled();
    expect(await prisma.conceptResource.count({ where: { conceptId: conceptIds.get('rung0-alpha') } })).toBe(3);
  });

  it('R1: rung-0 hits the judge throws away do NOT suppress web discovery', async () => {
    // The starvation case. Three near-but-wrong library rows are returned by rung 0
    // and rejected by the judge; pre-R1 their RAW count zeroed the web budget and
    // the concept was unfillable forever.
    judgeVerdict = { role: 'teaches', coverageScore: 0.1 };
    const attached = await sourceFor('rung0-beta', true);

    expect(attached).toBe(0);
    expect(youtubeProng).toHaveBeenCalled();
    expect(await prisma.conceptResource.count({ where: { conceptId: conceptIds.get('rung0-beta') } })).toBe(0);
  });

  it('R2: the rejected rows are remembered against the concept, with their scores', async () => {
    const rows = await prisma.conceptCandidateRejection.findMany({
      where: { conceptId: conceptIds.get('rung0-beta') },
      select: { resourceId: true, coverageScore: true },
    });
    expect(rows.map((r) => r.resourceId).sort()).toEqual([...libraryIds].sort());
    expect(rows.map((r) => r.coverageScore)).toEqual([0.1, 0.1, 0.1]);
  });

  it('R2: a later run never re-judges the remembered rows — even if the judge would now keep them', async () => {
    // Same concept, same three library rows, but a verdict that WOULD attach all
    // three. Rung 0 excludes them on the rejection memory alone, so the judge is
    // never offered them and nothing attaches. Pre-R2 this pass re-bought the same
    // verdict on the same rows, on every remediation, forever.
    judgeVerdict = { role: 'teaches', coverageScore: 0.9 };
    const attached = await sourceFor('rung0-beta', true);

    expect(attached).toBe(0);
    expect(await prisma.conceptResource.count({ where: { conceptId: conceptIds.get('rung0-beta') } })).toBe(0);
    // The exclusion is per CONCEPT: beta's memory must not starve another concept.
    expect(await prisma.conceptCandidateRejection.count({ where: { conceptId: conceptIds.get('rung0-alpha') } })).toBe(0);
  });

  it('R2: reclassifying a resource clears its rejections, buying it one more look', async () => {
    const before = await prisma.conceptCandidateRejection.count({ where: { resourceId: libraryIds[0] } });
    expect(before).toBe(1);

    await applyReclassification(libraryIds[0], {
      primary: { topic: TOPIC, relevance: 0.7, origin: 'classifier', contested: false },
      secondaries: [],
    });

    expect(await prisma.conceptCandidateRejection.count({ where: { resourceId: libraryIds[0] } })).toBe(0);
    // Scoped to the repaired row — the other two stay remembered.
    expect(await prisma.conceptCandidateRejection.count({ where: { conceptId: conceptIds.get('rung0-beta') } })).toBe(2);
  });

  it('R1: a full target of `uses` attachments still buys a web look when a primary is required', async () => {
    judgeVerdict = { role: 'uses', coverageScore: 0.9 };
    const attached = await sourceFor('rung0-gamma', true);

    // Numerically the target is full — but nothing here can be a Lesson primary,
    // so readiness still calls the concept a hole and the budget floors at 1.
    expect(attached).toBe(3);
    expect(youtubeProng).toHaveBeenCalled();
  });

  it('requirePrimary: false (the thickener) leaves the cost policy exactly as it was', async () => {
    judgeVerdict = { role: 'uses', coverageScore: 0.9 };
    const attached = await sourceFor('rung0-delta', false);

    expect(attached).toBe(3);
    expect(youtubeProng).not.toHaveBeenCalled();
  });

  // LAST on purpose: this one MOVES a row off the topic's shelf, so any earlier
  // case that expects rung 0 to return three rows would start failing behind it.
  it('R2: a T4b quorum refile clears the rejections of the row it moved, not its siblings', async () => {
    // The T4b driver's two lines (refile-quorum-topics.ts:191-196) — the pure
    // decision, then the shared write seam. Driven through `decideRefile` rather
    // than a hand-built decision so a future change to what a refile writes has to
    // come past this test.
    const decision = decideRefile(
      { id: libraryIds[1], title: 'Alpha lesson 1', currentTopic: TOPIC, relevance: 0.4, unvouchable: MOVED_TOPIC, newTopic: null },
      MOVED_TOPIC,
    );
    expect(typeof decision).not.toBe('string');
    if (typeof decision === 'string') return;

    expect(await prisma.conceptCandidateRejection.count({ where: { resourceId: libraryIds[1] } })).toBe(1);
    await applyReclassification(libraryIds[1], decision);

    // The refile really committed (not a no-op that would make the clear vacuous).
    const moved = await prisma.resource.findUnique({ where: { id: libraryIds[1] }, select: { topic: true } });
    expect(moved?.topic).toBe(MOVED_TOPIC);

    expect(await prisma.conceptCandidateRejection.count({ where: { resourceId: libraryIds[1] } })).toBe(0);
    // Scoped to the moved row: libraryIds[2] never moved, so beta still remembers it.
    expect(await prisma.conceptCandidateRejection.count({ where: { resourceId: libraryIds[2] } })).toBe(1);
  });
});
