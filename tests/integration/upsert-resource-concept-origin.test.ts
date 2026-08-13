// DB integration test for the Q1 follow-up: a discovery ROOT is stamped
// `conceptOrigin: 'derived'`, so its tags stay in the grounding vocabulary.
//
// Q1 stamped the four CHILD call sites; the parent create took the column default
// (`inherited`), which is the claim "these tags came from a failed derivation upstream".
// For a root that is simply false — a root is outside the inheritance path P1 broke, and
// its array came from its own sourcing-time extraction. Q3's backfill already decided
// this for 629 existing roots.
//
// The consequence is what the second assertion pins: `loadTopicVocab` admits `derived`
// only, so an `inherited` root drops out of the grounding vocabulary permanently, and the
// next derivation on that shelf is grounded on a vocabulary missing everything discovery
// has found since. Silent, incremental, and invisible in every count Q3 reported.
//
// An un-routed container with no children and no filing: no Vertex call, no network, no
// classifier. Self-cleaning marker topic; skips cleanly without DATABASE_URL.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { loadTopicVocab } from '@/lib/agents/decomposition/concepts';
import { describeDb } from './db';

const TOPIC = '__verify_concept_origin__';
const URL = 'https://verify-concept-origin.example.com/course/index';
const TAUGHT = '__verify_co_eigenvalues__';
const PREREQ = '__verify_co_matrices__';

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
}

describeDb('upsertResource — root concept provenance (Q1 follow-up)', () => {
  let resourceId: string;

  beforeAll(async () => {
    await cleanup();
    const res = await upsertResource(
      TOPIC,
      {
        url: URL,
        title: 'A sourced root',
        type: 'course',
        difficulty: 'beginner',
        durationMin: 600,
        durationSource: 'estimated' as const,
        summary: 'root',
        prerequisiteConcepts: [PREREQ],
        conceptsTaught: [TAUGHT],
      },
      { status: 'human_review', children: [], reason: 'test container' },
    );
    expect(res.outcome).toBe('inserted');
    resourceId = res.resourceId!;
  });
  afterAll(cleanup);

  it('stamps the root `derived`, not the `inherited` column default', async () => {
    const row = await prisma.resource.findUniqueOrThrow({
      where: { id: resourceId },
      select: { conceptOrigin: true, conceptsTaught: true },
    });
    expect(row.conceptOrigin).toBe('derived');
    expect(row.conceptsTaught).toEqual([TAUGHT]);
  });

  it('keeps the root’s tags in the topic grounding vocabulary', async () => {
    const vocab = await loadTopicVocab(TOPIC);
    expect(vocab).toContain(TAUGHT);
    expect(vocab).toContain(PREREQ);
  });
});
