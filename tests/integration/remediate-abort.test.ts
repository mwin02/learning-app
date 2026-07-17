// Audit block 4 (finding 2.2): the deadline/shutdown abort must reach
// remediation's inner loop and its sourcing/split primitives — a zombie pipeline
// must stop BEFORE the first hole's web-sourcing call, not at the next pass
// boundary minutes later. Verified the cheap way (prior blocks' pattern): a
// pre-aborted AbortSignal into the real functions over a synthetic
// __verify_abort__ Path. Real DB, ZERO LLM spend — every assertion is that the
// abort throws before any model/web call could start (an unthreaded regression
// would surface here as a slow test burning real discovery + judge calls).
//
// Run with the compose workers STOPPED (docker compose --profile workers stop
// worker): a live worker doesn't claim these rows (no CourseRequest is enqueued),
// but its reclaim passes scan the whole RemediationJob table.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { PathStatus, RemediationState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { remediatePath } from '@/lib/agents/track/remediate-path';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';
import { splitConcept } from '@/lib/agents/track/split-concept';
import { describeDb } from './db';

const MARK = '__verify_abort__';

async function cleanup() {
  // Path deletion cascades Concepts + RemediationJobs.
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

function abortedSignal(reason: string): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error(reason));
  return controller.signal;
}

// A `building` Path with two bare spine concepts (no ConceptResource rows) — two
// genuine holes, so an unaborted run would enter the per-hole sourcing loop.
async function makeHoleyPath(suffix: string) {
  const path = await prisma.path.create({
    data: { topic: `${MARK}${suffix}`, status: PathStatus.building },
    select: { id: true },
  });
  await prisma.concept.createMany({
    data: [
      { pathId: path.id, slug: 'hole-one', title: 'Hole One' },
      { pathId: path.id, slug: 'hole-two', title: 'Hole Two' },
    ],
  });
  return path;
}

describeDb('remediation abort threading (audit 2.2)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('an already-aborted signal fails the job before ANY sourcing starts (zero model calls)', async () => {
    const path = await makeHoleyPath('loop');

    const result = await remediatePath(path.id, {
      abortSignal: abortedSignal('job deadline exceeded (verify)'),
    });

    // The abort throw lands in runRemediation's catch: the job is claimed, then
    // failed with the abort reason — freeing the active-per-path index — and no
    // hole was sourced (both concepts still have zero candidates).
    expect(result.outcome).toBe('failed');
    const job = await prisma.remediationJob.findFirstOrThrow({ where: { pathId: path.id } });
    expect(job.state).toBe(RemediationState.failed);
    expect(job.error).toContain('job deadline exceeded (verify)');
    const attached = await prisma.conceptResource.count({ where: { concept: { pathId: path.id } } });
    expect(attached).toBe(0);
  });

  it('sourceAndAttachConcept rejects up front on an aborted signal (before the library rung / discovery ladder)', async () => {
    const path = await makeHoleyPath('source');
    const concept = await prisma.concept.findFirstOrThrow({
      where: { pathId: path.id, slug: 'hole-one' },
    });

    await expect(
      sourceAndAttachConcept({
        pathId: path.id,
        topic: `${MARK}source`,
        conceptId: concept.id,
        slug: concept.slug,
        title: concept.title,
        abortSignal: abortedSignal('worker shutdown (verify)'),
      }),
    ).rejects.toThrow('worker shutdown (verify)');
  });

  it('splitConcept rejects on an aborted signal without mutating the map', async () => {
    const path = await makeHoleyPath('split');
    const concept = await prisma.concept.findFirstOrThrow({
      where: { pathId: path.id, slug: 'hole-one' },
    });

    // The AI SDK checks the signal before issuing the author request, so this
    // rejects without a model call; the coarse concept must survive untouched.
    await expect(
      splitConcept({
        pathId: path.id,
        topic: `${MARK}split`,
        concept: { id: concept.id, slug: concept.slug, title: concept.title },
        evidence: [],
        abortSignal: abortedSignal('job deadline exceeded (verify)'),
      }),
    ).rejects.toThrow();
    expect(await prisma.concept.count({ where: { pathId: path.id } })).toBe(2);
  });
});
