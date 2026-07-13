// DB integration test for the Block 3 decompose-time hook
// (rejudgeForDemandingPaths): a decomposed container with a sourced-for pair on
// ONE concept gets its children routed across ALL of the demanding path's
// concepts by embedding distance — each child attached to its matching concept,
// not dumped on the sourcing one — with readiness recomputed; a second run
// no-ops (already-attached exclusion); and once the demanding concepts are gone
// (cascade) the hook is a clean zero-pair no-op.
//
// LLM leaves are mocked so this costs no tokens and stays deterministic:
//   - embedQuery returns fixed orthogonal unit vectors keyed by title keyword
//     (child/concept embeddings are hand-written the same way), so routing
//     distances are exactly 0 (match) and 1 (non-match, over the 0.48 ceiling);
//   - judgeCandidates keeps everything it is shown as `teaches` @ 0.9 — the
//     assertions are about ROUTING and attach mechanics, not judge quality.
// Everything else (pgvector routing SQL, attach transaction, promote-on-attach,
// recomputeReadiness, cascades) runs for real against the dev DB.
//
// Self-cleaning: rows use a __verify_rjsf__ marker. Skips without DATABASE_URL.
import { beforeAll, afterAll, it, expect, vi } from 'vitest';

vi.mock('@/lib/ai/embeddings', () => ({
  buildEmbeddingText: (r: { title: string }) => r.title,
  embedTexts: async () => {
    throw new Error('embedTexts should not be called in this test');
  },
  embedQuery: async (text: string) => unitVec(text.includes('Alpha') ? 0 : 1),
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

import { prisma } from '@/lib/db';
import { rejudgeForDemandingPaths } from '@/lib/agents/decomposition/rejudge-sourced-for';
import { describeDb } from './db';

const TOPIC = '__verify_rjsf__';

// 768-dim unit vector with a 1 at `i` — orthogonal pairs give cosine distance 1.
function unitVec(i: number): number[] {
  const v = new Array(768).fill(0);
  v[i] = 1;
  return v;
}

async function writeEmbedding(resourceId: string, vec: number[]) {
  await prisma.$executeRawUnsafe(
    `UPDATE "Resource" SET embedding = '[${vec.join(',')}]'::vector WHERE id = '${resourceId}'`,
  );
}

let pathId: string;
let conceptAlphaId: string;
let conceptBetaId: string;
let containerId: string;
let childAlphaId: string;
let childBetaId: string;

async function cleanup() {
  // Path first: deleting it cascades the concepts, whose ConceptResource links
  // cascade with them — those links otherwise block the resource deletes
  // (ConceptResource has no cascade on its resource side).
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
}

const resourceData = (source: string, slug: string, title: string) => ({
  slug,
  topic: TOPIC,
  title,
  url: `https://verify-rjsf.example.com/${slug}`,
  type: 'video' as const,
  durationMin: 20,
  summary: title,
  difficulty: 'beginner' as const,
  prerequisiteConcepts: [],
  conceptsTaught: [],
  status: 'pending_review' as const,
  sourceId: source,
});

describeDb('rejudgeForDemandingPaths — decompose-time hook', () => {
  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${TOPIC}src`, name: 'RJSF source', url: 'https://verify-rjsf.example.com', kind: 'community' },
      select: { id: true },
    });
    const path = await prisma.path.create({
      data: {
        topic: TOPIC,
        concepts: {
          create: [
            { slug: 'rjsf-alpha', title: 'Alpha subject' },
            { slug: 'rjsf-beta', title: 'Beta subject' },
          ],
        },
      },
      select: { id: true, concepts: { select: { id: true, slug: true } } },
    });
    pathId = path.id;
    conceptAlphaId = path.concepts.find((c) => c.slug === 'rjsf-alpha')!.id;
    conceptBetaId = path.concepts.find((c) => c.slug === 'rjsf-beta')!.id;

    // A container that already went through decomposition review, with two
    // atomic children whose embeddings match one concept each.
    const container = await prisma.resource.create({
      data: { ...resourceData(source.id, `${TOPIC}container`, 'RJSF container'), decompositionStatus: 'decomposed' },
      select: { id: true },
    });
    containerId = container.id;
    const childAlpha = await prisma.resource.create({
      data: {
        ...resourceData(source.id, `${TOPIC}child-alpha`, 'Chapter on Alpha'),
        parentResourceId: containerId,
        orderInParent: 0,
      },
      select: { id: true },
    });
    const childBeta = await prisma.resource.create({
      data: {
        ...resourceData(source.id, `${TOPIC}child-beta`, 'Chapter on Beta'),
        parentResourceId: containerId,
        orderInParent: 1,
      },
      select: { id: true },
    });
    childAlphaId = childAlpha.id;
    childBetaId = childBeta.id;
    await writeEmbedding(childAlphaId, unitVec(0));
    await writeEmbedding(childBetaId, unitVec(1));

    // Provenance: the container was sourced for the ALPHA concept only.
    await prisma.resourceSourcedFor.create({
      data: { resourceId: containerId, conceptId: conceptAlphaId },
    });
  });
  afterAll(cleanup);

  it('routes each child to its matching concept across the whole demanding path', async () => {
    const result = await rejudgeForDemandingPaths(containerId);
    expect(result.pairs).toBe(1);
    expect(result.candidates).toBe(2);
    // Both concepts judged — beta too, despite the pair living on alpha.
    expect(result.attachments).toHaveLength(2);

    const links = await prisma.conceptResource.findMany({
      where: { conceptId: { in: [conceptAlphaId, conceptBetaId] } },
      select: { conceptId: true, resourceId: true, role: true },
    });
    // Orthogonal embeddings (distance 1 > the 0.48 ceiling) keep each child out
    // of the other concept's judge call — exactly one link per concept.
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({ conceptId: conceptAlphaId, resourceId: childAlphaId, role: 'teaches' });
    expect(links).toContainEqual({ conceptId: conceptBetaId, resourceId: childBetaId, role: 'teaches' });
  });

  it('promotes attached children from pending_review to active (promote-on-attach)', async () => {
    const children = await prisma.resource.findMany({
      where: { id: { in: [childAlphaId, childBetaId] } },
      select: { status: true },
    });
    expect(children.map((c) => c.status)).toEqual(['active', 'active']);
  });

  it('is idempotent — a re-run judges nothing new and attaches nothing', async () => {
    const result = await rejudgeForDemandingPaths(containerId);
    expect(result.pairs).toBe(1);
    // Concepts still route, but the already-attached exclusion empties both
    // groups before the judge — every attachment entry reports 0 attached.
    expect(result.attachments.every((a) => a.attached === 0)).toBe(true);
    expect(await prisma.conceptResource.count({ where: { conceptId: { in: [conceptAlphaId, conceptBetaId] } } })).toBe(2);
  });

  it('no-ops cleanly when the demanding concept is deleted (cascade)', async () => {
    await prisma.concept.delete({ where: { id: conceptAlphaId } });
    const result = await rejudgeForDemandingPaths(containerId);
    expect(result).toEqual({ pairs: 0, candidates: 0, attachments: [] });
  });
});
