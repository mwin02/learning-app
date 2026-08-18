// DB integration test for serveability S2: `classifyServeability` runs at BOTH Resource
// creation seams — the discovery root in `upsertResource` and `createChild` — and a row
// that fails it is created soft-deprecated instead of admitted.
//
// The root half is the point of the block: before S2 the open-web discovery path created
// every root `pending_review` with no content check at all, so the least-trusted admission
// path was the unguarded one. The child half asserts the new rule composes with the
// existing furniture branch rather than replacing it.
//
// Deliberately cheap: the serveable atomic root is inserted with a caller-supplied vector so
// its post-commit embed is skipped (T2a), and every other insert is either deprecated or a
// container, so it never joins `embedTasks`. The one exception is the good child of the
// decomposed-interactive container below, which costs a single embed — the price of showing
// that its parent's children survive intact. No `filing` argument is passed anywhere, which
// is what keeps `fileChildren`'s classifier off this file.
//
// Self-cleaning marker topic + URL marker; skips cleanly without DATABASE_URL. Run with the
// dockerized workers stopped.
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { upsertResource } from '@/lib/agents/decomposition/upsert-resource';
import type { ChildInput, DecompositionResult } from '@/lib/agents/decomposition/decompose';
import { describeDb } from './db';

const MARKER = '__verify_serve__';
const TOPIC = MARKER;
const HOST = 'https://verify-serve.example.com';
const INTERACTIVE_URL = `${HOST}/${MARKER}/widget`;
const SERVEABLE_URL = `${HOST}/${MARKER}/lesson`;
const CONTAINER_URL = `${HOST}/${MARKER}/course`;
const SECOND_CONTAINER_URL = `${HOST}/${MARKER}/course-2`;
// A Khan `/pi/` coding challenge (clause 5). Carries the marker so cleanup can find it and
// so it can never collide with a real Khan row in the shared dev DB.
const KHAN_CHALLENGE_URL = `https://www.khanacademy.org/computing/${MARKER}/pi/verify-serve-challenge`;
// Fails BOTH classifiers: `Feedback` is a whole-title furniture phrase and the URL is a
// Khan `/pi/` challenge.
const KHAN_FURNITURE_URL = `https://www.khanacademy.org/computing/${MARKER}/pi/verify-serve-feedback`;

// An `interactive` root that DECOMPOSED — a container doing its job, exempt from the
// interactive-type rule — plus the one good lesson under it.
const INTERACTIVE_CONTAINER_URL = `${HOST}/${MARKER}/interactive-course`;
const INTERACTIVE_CONTAINER_CHILD_URL = `${HOST}/${MARKER}/interactive-course/lesson-1`;

const DIM = 768;
const VECTOR = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

async function cleanup() {
  await prisma.resource.deleteMany({
    where: { OR: [{ topic: TOPIC }, { url: { contains: MARKER } }] },
  });
}

const root = (url: string, type: string, title: string) => ({
  url,
  title,
  type,
  difficulty: 'beginner',
  durationMin: 20,
  durationSource: 'estimated' as const,
  summary: 'serveability fixture',
  prerequisiteConcepts: [] as string[],
  conceptsTaught: [] as string[],
});

// `orderInParent` is unique per parent, so siblings must not share one.
const child = (url: string, title: string, orderInParent = 1): ChildInput => ({
  url,
  title,
  type: 'article',
  difficulty: 'beginner',
  durationMin: 10,
  durationSource: 'estimated' as const,
  summary: 'serveability child fixture',
  prerequisiteConcepts: [],
  conceptsTaught: [],
  conceptOrigin: 'derived',
  orderInParent,
});

const atomic: DecompositionResult = { status: 'atomic', children: [] };
const rowByUrl = (url: string) =>
  prisma.resource.findUnique({
    where: { url },
    select: { id: true, status: true, deprecationSeverity: true },
  });

describeDb('ingestion — row-level serveability at both seams (S2)', () => {
  let interactiveId: string | null;
  let serveableId: string | null;
  let interactiveContainerId: string | null;
  const warnings: string[] = [];

  // Any non-JSON warning from elsewhere in the graph is not this test's evidence.
  type WarnLine = { event: string; url?: string; reason?: string };
  const warnLines = (url: string): WarnLine[] =>
    warnings.flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        const entry = parsed as WarnLine;
        return entry?.url === url ? [entry] : [];
      } catch {
        return [];
      }
    });

  beforeAll(async () => {
    await cleanup();
    // logWarn emits one JSON object per line through console.warn (`@/lib/log`), which is
    // the only way to observe "one warning per classifier" from the outside.
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(String(args[0]));
    });
    try {
      const interactive = await upsertResource(
        TOPIC,
        root(INTERACTIVE_URL, 'interactive', 'A sorting visualizer'),
        atomic,
      );
      expect(interactive.outcome).toBe('inserted');
      interactiveId = interactive.resourceId;
      expect(interactive.atomicIds).toEqual([]);

      const serveable = await upsertResource(
        TOPIC,
        root(SERVEABLE_URL, 'article', 'How merge sort works'),
        atomic,
        VECTOR,
      );
      expect(serveable.outcome).toBe('inserted');
      serveableId = serveable.resourceId;
      expect(serveable.atomicIds).toEqual([serveable.resourceId]);

      const container = await upsertResource(
        TOPIC,
        root(CONTAINER_URL, 'course', 'A course'),
        {
          status: 'decomposed',
          children: [
            child(KHAN_CHALLENGE_URL, 'Challenge: bouncing ball'),
            child(KHAN_FURNITURE_URL, 'Feedback', 2),
          ],
        },
      );
      // A failed child insert rolls the whole transaction back into `skipped`, which would
      // otherwise look like "the child was never created" in the assertions below.
      expect(container.outcome).toBe('inserted');
      expect(container.atomicIds).toEqual([]);

      const interactiveContainer = await upsertResource(
        TOPIC,
        root(INTERACTIVE_CONTAINER_URL, 'interactive', 'An interactive course'),
        {
          status: 'decomposed',
          children: [child(INTERACTIVE_CONTAINER_CHILD_URL, 'Lesson 1: what a heap is')],
        },
      );
      expect(interactiveContainer.outcome).toBe('inserted');
      interactiveContainerId = interactiveContainer.resourceId;
    } finally {
      warn.mockRestore();
    }
  });
  afterAll(cleanup);

  it('creates an unserveable atomic root soft-deprecated, not pending_review', async () => {
    const row = await rowByUrl(INTERACTIVE_URL);
    expect(row).toMatchObject({ status: 'deprecated', deprecationSeverity: 'soft' });
    expect(row?.id).toBe(interactiveId);
  });

  it('leaves a serveable root exactly as before — pending_review and pickable', async () => {
    const row = await rowByUrl(SERVEABLE_URL);
    expect(row).toMatchObject({ status: 'pending_review', deprecationSeverity: null });
    expect(row?.id).toBe(serveableId);
  });

  // The regression this case exists for: `interactive` is a container type, so deprecating
  // an interactive root on its type alone destroys a WORKING container — and puts it
  // outside `listPendingReview` (roots with `status: 'pending_review'`), so it can never be
  // approved to `active` and its children never surface for review under it.
  it('admits a decomposed interactive container, children intact', async () => {
    const parent = await prisma.resource.findUnique({
      where: { url: INTERACTIVE_CONTAINER_URL },
      select: { id: true, status: true, deprecationSeverity: true, decompositionStatus: true },
    });
    expect(parent).toMatchObject({
      id: interactiveContainerId,
      status: 'pending_review',
      deprecationSeverity: null,
      decompositionStatus: 'decomposed',
    });

    const children = await prisma.resource.findMany({
      where: { parentResourceId: interactiveContainerId ?? undefined },
      select: { url: true, status: true, deprecationSeverity: true },
    });
    expect(children).toEqual([
      {
        url: INTERACTIVE_CONTAINER_CHILD_URL,
        status: 'pending_review',
        deprecationSeverity: null,
      },
    ]);
  });

  it('creates an unserveable child rather than skipping it, soft-deprecated', async () => {
    const row = await rowByUrl(KHAN_CHALLENGE_URL);
    // The row EXISTS: skipping the insert would lose the URL, and the next decomposition
    // would re-admit it with nothing for the F8 dedup to collapse onto.
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ status: 'deprecated', deprecationSeverity: 'soft' });
  });

  it('deprecates a row failing both classifiers once, warning once per classifier', async () => {
    expect(await prisma.resource.count({ where: { url: KHAN_FURNITURE_URL } })).toBe(1);
    const row = await rowByUrl(KHAN_FURNITURE_URL);
    expect(row).toMatchObject({ status: 'deprecated', deprecationSeverity: 'soft' });

    const events = warnLines(KHAN_FURNITURE_URL);
    expect(events.map((e) => e.event).sort()).toEqual([
      'upsert-resource.non_teaching_child',
      'upsert-resource.unserveable_child',
    ]);
    expect(events.find((e) => e.event === 'upsert-resource.unserveable_child')?.reason).toBe(
      'khan-project-item',
    );

    // ...and the root seam names its own classifier on the interactive root.
    const rootWarn = warnLines(INTERACTIVE_URL);
    expect(rootWarn.map((e) => e.event)).toEqual(['upsert-resource.unserveable_root']);
    expect(rootWarn[0].reason).toBe('interactive-type');
  });

  it('collapses a re-ingestion onto the deprecated rows instead of creating a second', async () => {
    const again = await upsertResource(
      TOPIC,
      root(INTERACTIVE_URL, 'interactive', 'A sorting visualizer'),
      atomic,
    );
    expect(again.outcome).toBe('skipped');
    expect(again.resourceId).toBe(interactiveId);
    expect(await prisma.resource.count({ where: { url: INTERACTIVE_URL } })).toBe(1);

    // The child seam's own dedup: a different container offering the same deprecated child
    // URL skips it rather than inserting a duplicate.
    const other = await upsertResource(
      TOPIC,
      root(SECOND_CONTAINER_URL, 'course', 'Another course'),
      { status: 'decomposed', children: [child(KHAN_CHALLENGE_URL, 'Challenge: bouncing ball')] },
    );
    expect(other.outcome).toBe('inserted');
    expect(await prisma.resource.count({ where: { url: KHAN_CHALLENGE_URL } })).toBe(1);
  });
});
