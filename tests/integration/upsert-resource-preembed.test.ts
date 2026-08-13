// DB integration test for topic filing T2a: a caller-supplied embedding is written
// INSIDE upsertResource's transaction, so the row arrives embedded — and a CONTAINER
// parent gets embedded too, without ever joining the pickable `atomicIds` set.
//
// Both properties are load-bearing:
//   - containers are the blind spot the plan exists for (the motivating mis-filing is a
//     45-leaf container whose children inherit its topic), so the T2b guardrail needs
//     their vector;
//   - `atomicIds` is the retrieval session's discovery allowlist, so a container leaking
//     into it would make an unpickable row visible to search.
//
// A container with no children queues no embed tasks, so this exercises the new path
// with NO Vertex call and NO network (the embeddability probe never fires). The
// remaining T2a behaviour — an ATOMIC parent skipping its post-commit re-embed — needs a
// live Vertex/HEAD round trip to observe and is covered by the manual verification run.
//
// Self-cleaning marker topic; skips cleanly without DATABASE_URL. Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import { describeDb } from './db';

const TOPIC = '__verify_preembed__';
const URL = 'https://verify-preembed.example.com/course/index';

// Distinctive and cheap to assert on: a re-embed by any other path would overwrite it
// with a real text-embedding-005 vector, which is dense and never exactly this.
const DIM = 768;
const VECTOR = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

async function cleanup() {
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: TOPIC } } });
}

describeDb('upsertResource — pre-insert embedding (T2a)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('writes the supplied vector on a container parent and keeps atomicIds empty', async () => {
    const res = await upsertResource(
      TOPIC,
      {
        url: URL,
        title: 'A multi-part course',
        type: 'course',
        difficulty: 'beginner',
        durationMin: 600,
        durationSource: 'estimated' as const,
        summary: 'container',
        prerequisiteConcepts: [],
        conceptsTaught: [],
      },
      // Parks as an un-routed container: unpickable, no children, no embed tasks.
      { status: 'human_review', children: [], reason: 'test container' },
      VECTOR,
    );

    expect(res.outcome).toBe('inserted');
    expect(res.decompositionStatus).toBe('human_review');
    // The regression this test exists for: a container is embedded but NOT pickable.
    expect(res.atomicIds).toEqual([]);

    const [row] = await prisma.$queryRaw<
      { v: string | null; embeddedAt: Date | null; updatedAt: Date }[]
    >`SELECT embedding::text AS v, "embeddedAt", "updatedAt" FROM "Resource" WHERE id = ${res.resourceId}`;

    expect(row.v).not.toBeNull();
    const parsed = row.v!.slice(1, -1).split(',').map(Number);
    expect(parsed).toHaveLength(DIM);
    expect(parsed[0]).toBeCloseTo(1);
    expect(parsed[1]).toBeCloseTo(0);
    // GREATEST("updatedAt", now()) — a bare now() inside a transaction is transaction-START
    // time and would leave the row looking stale to embedMissing()'s backfill.
    expect(row.embeddedAt).not.toBeNull();
    expect(row.embeddedAt!.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
  });
});
