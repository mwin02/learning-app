// Tests for the driver that decides `sweep-serveability.ts`'s `type-url-page-conflict`
// escalation. Four properties, and the first is the one the driver was rewritten for:
//
//   1. THE COLLISION IS ASKED BEFORE THE FORM GUARDS. A duplicate is a duplicate whatever it
//      is typed, so a stored type the repair never touches must not turn a decidable row into
//      an escalation. The first version of this driver read the guards first and escalated
//      the production `interactive` duplicate on exactly that mistake — two individually
//      correct refusals refusing a row neither meant to, which is `library-enforcement.md`'s
//      composition warning happening in one function.
//   2. THE TWO OUTCOMES AND THEIR SEAMS. A repoint is a field update, so the row KEEPS its
//      ConceptResource links — it is still the same lesson at a new address. A deprecation
//      goes through `applyPendingReview`, so the links are dropped and readiness recomputed.
//      Routing either through the other's seam is the defect these assertions exist to catch.
//   3. THE RETIRED INCUMBENT IS A THIRD STATE, inherited from `repoint-khan-pt.ts`: the URL
//      is just as taken, so the repoint is impossible, but nothing at it can serve the
//      lesson, so the deprecation is dishonest. Refuse both.
//   4. IDEMPOTENCE. A repointed row's URL kind now agrees with its page and a deprecated row
//      is outside the write window, so a second run finds an empty population.
//
// Split by cost as its two sibling drivers' tests are: `planFor` is pure, so the outcome
// table is a plain `describe`, and `describeDb` covers only what the seams do to rows.
//
// The DB half never calls `main()` and never touches a row it did not seed: `collectPlans`
// scans the whole table (the population is the classifier's to decide), so every assertion is
// filtered to the marker first. A hand-built probe map is passed in rather than reading
// `docs/audits/`, so the test is hermetic on a machine with no probe artifacts.
//
// Self-cleaning `__verify_c4__` marker; skips cleanly without DATABASE_URL. Run with the
// dockerized workers stopped.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { ConceptResourceRole, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { ProbeEvidence } from '@/lib/curation/serveability-probe';
import {
  applyPlan,
  collectPlans,
  planFor,
  type Planned,
} from '../../scripts/resolve-type-url-conflicts';
import { describeDb } from './db';

const MARK = '__verify_c4__';
const TOPIC = `${MARK}-topic`;

const article = (unit: string, slug: string) =>
  `https://www.khanacademy.org/math/${MARK}/${unit}/a/${slug}`;
const video = (unit: string, slug: string) =>
  `https://www.khanacademy.org/math/${MARK}/${unit}/v/${slug}`;

const FREE_URL = article('limits', 'moves-to-a-free-address');
const FREE_TARGET = video('limits-renamed', 'moves-to-a-free-address');
const DUP_URL = article('vectors', 'already-filed');
const DUP_TARGET = video('vectors', 'already-filed');
const RETIRED_URL = article('stats', 'held-by-a-retired-row');
const RETIRED_TARGET = video('stats', 'held-by-a-retired-row');

// A probe of a Khan `/a/` URL that client-side redirects to a video: `pageKind: 'video'`
// against a stored `/a/` address is the contradiction C3 detects and this driver resolves.
const videoProbe = (landed: string): ProbeEvidence => ({
  url: landed,
  title: 'A video that used to be an article',
  pageKind: 'video',
  videoIds: ['C4vidID0001'],
  articleWords: null,
  articleWordsBeforeExpand: null,
  collapsedExpanded: 0,
  workedExamples: null,
  widgets: 0,
  mainWords: 3000,
  hasEditor: false,
  blocked: false,
});

// ── the outcome table, pure ────────────────────────────────────────────────────────────────

const row = (over: Partial<Parameters<typeof planFor>[0]> = {}) => ({
  id: 'r1',
  url: FREE_URL,
  title: 'A lesson that moved',
  type: 'video' as const,
  status: 'active' as const,
  decompositionStatus: 'atomic' as const,
  ...over,
});
type Holder = NonNullable<Parameters<typeof planFor>[2]>;
const outcome = (
  over: Partial<Parameters<typeof planFor>[0]> = {},
  probe: ProbeEvidence | null = videoProbe(FREE_TARGET),
  holder: Holder | null = null,
) => planFor(row(over), probe, holder);
const holderAt = (status: Holder['status']): Holder => ({ id: 'incumbent', title: 'Already filed', status });

describe('resolve-type-url-conflicts — the outcomes (pure)', () => {
  it('repoints a row whose landed URL nobody holds', () => {
    expect(outcome()).toEqual({ action: 'repoint', to: FREE_TARGET });
  });

  it('deprecates a row whose landed URL is already a servable row', () => {
    for (const status of ['active', 'pending_review'] as const) {
      expect(outcome({}, videoProbe(DUP_TARGET), holderAt(status))).toMatchObject({
        action: 'deprecate',
        holderId: 'incumbent',
        to: DUP_TARGET,
      });
    }
  });

  // PROPERTY 1. The stored type is the repoint branch's business and nobody else's: this row
  // is a duplicate of a lesson already filed at its landed address, and which of the two form
  // signals it currently agrees with changes nothing about that.
  it('deprecates an `interactive` duplicate rather than escalating it on a type the repair never touches', () => {
    expect(outcome({ type: 'interactive' }, videoProbe(DUP_TARGET), holderAt('active'))).toMatchObject({
      action: 'deprecate',
      holderId: 'incumbent',
    });
  });

  // PROPERTY 3. The unique constraint does not care that the incumbent is retired, so the
  // repoint is impossible — and deprecating against a copy nobody can be served would retire
  // the last servable copy of the lesson.
  it('escalates when the landed URL is held by a deprecated row', () => {
    const o = outcome({}, videoProbe(RETIRED_TARGET), holderAt('deprecated'));
    expect(o).toMatchObject({ action: 'escalate' });
    expect(o.action === 'escalate' && o.reason).toContain('incumbent');
  });

  // Repoint-only guards, read after the collision.
  it('escalates a repoint that would leave the row describing itself wrongly', () => {
    const o = outcome({ type: 'article' });
    expect(o).toMatchObject({ action: 'escalate' });
    expect(o.action === 'escalate' && o.reason).toContain('would leave the form wrong');
  });

  it('escalates when the landed URL names no content kind', () => {
    expect(outcome({}, videoProbe(`https://www.khanacademy.org/math/${MARK}/limits`))).toMatchObject({
      action: 'escalate',
    });
  });

  it('escalates a row with no probe — the landed URL is the whole evidence base', () => {
    expect(outcome({}, null)).toMatchObject({ action: 'escalate' });
  });

  it('escalates when the page landed off Khan entirely', () => {
    expect(outcome({}, videoProbe('https://example.invalid/v/elsewhere'))).toMatchObject({
      action: 'escalate',
    });
  });

  // The write window, asked ahead of everything: a decided row is not re-decided, and an
  // unresolved one is refused by the reject seam anyway.
  it('never re-decides a deprecated row', () => {
    expect(outcome({ status: 'deprecated' })).toMatchObject({ action: 'escalate' });
  });

  it('declines a row sitting in the decomposition queue', () => {
    for (const decompositionStatus of ['pending', 'human_review'] as const) {
      expect(outcome({ decompositionStatus })).toMatchObject({ action: 'escalate' });
    }
  });
});

// ── the write seams ────────────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

describeDb('resolve-type-url-conflicts — the write seams', () => {
  let ids: Record<string, string>;
  let pathId: string;
  let keptConceptId: string;
  let lostConceptId: string;
  let probes: Map<string, ProbeEvidence | null>;

  const seed = async (
    sourceId: string,
    slug: string,
    url: string,
    type: 'article' | 'video' | 'interactive',
    status: 'active' | 'deprecated' = 'active',
  ) =>
    (
      await prisma.resource.create({
        data: {
          slug: `${MARK}-${slug}`,
          topic: TOPIC,
          title: `C4 ${slug}`,
          url,
          type,
          durationMin: 12,
          durationSource: 'estimated',
          summary: 'C4 conflict fixture',
          difficulty: 'beginner',
          status,
          ...(status === 'deprecated' ? { deprecationSeverity: 'soft' as const } : {}),
          decompositionStatus: 'atomic',
          origin: 'agent',
          prerequisiteConcepts: [],
          conceptsTaught: [],
          sourceId,
        },
        select: { id: true },
      })
    ).id;

  // Never the whole table: `collectPlans` reads every row by design.
  const mine = async (): Promise<Map<string, Planned>> =>
    new Map(
      (await collectPlans(probes))
        .filter((p) => p.row.url.includes(MARK))
        .map((p) => [p.row.url, p]),
    );

  // `main()`'s own filter: an escalation is never offered to `applyPlan`, so a run cannot
  // action a row the driver refused to decide.
  const runDriver = async () => {
    const applied: string[] = [];
    for (const p of (await mine()).values()) {
      if (p.plan.action === 'escalate') continue;
      const result = await applyPlan(p);
      expect(result.ok).toBe(true);
      applied.push(p.plan.action);
    }
    return applied.sort();
  };

  const rowById = (id: string) =>
    prisma.resource.findUniqueOrThrow({
      where: { id },
      select: { url: true, type: true, status: true, deprecationSeverity: true, durationMin: true },
    });

  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${MARK}-src`, name: 'C4 source', url: 'https://www.khanacademy.org', kind: 'community' },
      select: { id: true },
    });
    ids = {
      free: await seed(source.id, 'free', FREE_URL, 'video'),
      dup: await seed(source.id, 'dup', DUP_URL, 'video'),
      // The row already filed at `dup`'s landed address — a perfectly good video resource
      // the repoint must not be allowed to write over.
      incumbent: await seed(source.id, 'incumbent', DUP_TARGET, 'video'),
      // The same shape one status apart: the URL is just as taken, but nothing here can
      // serve the lesson.
      heldByRetired: await seed(source.id, 'held-by-retired', RETIRED_URL, 'video'),
      retiredIncumbent: await seed(source.id, 'retired-incumbent', RETIRED_TARGET, 'video', 'deprecated'),
    };

    // Two concepts on one spine-ready Path: one covered by the row about to be REPOINTED (its
    // link must survive) and one covered only by the row about to be DEPRECATED (its link
    // must go, and the Path must regress).
    pathId = (await prisma.path.create({ data: { topic: TOPIC, status: PathStatus.spine_ready }, select: { id: true } })).id;
    keptConceptId = (
      await prisma.concept.create({ data: { pathId, slug: `${MARK}-c-kept`, title: 'C4 kept' }, select: { id: true } })
    ).id;
    lostConceptId = (
      await prisma.concept.create({ data: { pathId, slug: `${MARK}-c-lost`, title: 'C4 lost' }, select: { id: true } })
    ).id;
    await prisma.conceptResource.create({
      data: { conceptId: keptConceptId, resourceId: ids.free, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
    });
    await prisma.conceptResource.create({
      data: { conceptId: lostConceptId, resourceId: ids.dup, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
    });

    probes = new Map([
      [ids.free, videoProbe(FREE_TARGET)],
      [ids.dup, videoProbe(DUP_TARGET)],
      [ids.heldByRetired, videoProbe(RETIRED_TARGET)],
    ]);
  });
  afterAll(cleanup);

  it('plans one outcome per conflicted row, and the incumbents are not in the population', async () => {
    const plans = await mine();
    expect(plans.get(FREE_URL)?.plan).toEqual({ action: 'repoint', to: FREE_TARGET });
    // The collision is found by reading the table, not by catching a constraint error.
    expect(plans.get(DUP_URL)?.plan).toMatchObject({ action: 'deprecate', holderId: ids.incumbent });
    expect(plans.get(RETIRED_URL)?.plan).toMatchObject({
      action: 'escalate',
      reason: expect.stringContaining(ids.retiredIncumbent),
    });
    // An incumbent's own URL and page agree, so the classifier reports no conflict on it.
    expect(plans.has(DUP_TARGET)).toBe(false);
    expect(plans.has(RETIRED_TARGET)).toBe(false);
  });

  it('applies each outcome through its own seam, and raises no unique-constraint error', async () => {
    expect(await runDriver()).toEqual(['deprecate', 'repoint']);

    // A repoint moves the URL and nothing else — not the type, not the duration.
    expect(await rowById(ids.free)).toEqual({
      url: FREE_TARGET,
      type: 'video',
      status: 'active',
      deprecationSeverity: null,
      durationMin: 12,
    });
    expect(await rowById(ids.dup)).toMatchObject({ status: 'deprecated', deprecationSeverity: 'soft' });
    // Never deleted — a Resource is referenced by ratings, reports and Lesson snapshots.
    expect(await prisma.resource.count({ where: { id: ids.dup } })).toBe(1);
    // The incumbent kept its URL: the collision was declined, not resolved for the newcomer.
    expect(await rowById(ids.incumbent)).toMatchObject({ url: DUP_TARGET, status: 'active' });
    // An escalation writes nothing, so both rows stay exactly as recoverable as they were.
    expect(await rowById(ids.heldByRetired)).toMatchObject({ url: RETIRED_URL, status: 'active' });
    expect(await rowById(ids.retiredIncumbent)).toMatchObject({ url: RETIRED_TARGET, status: 'deprecated' });
  });

  // THE property of the repoint branch. It is a field update precisely because
  // `applyPendingReview` would have dropped this link.
  it('keeps the repointed row attached to its concept', async () => {
    expect(await prisma.conceptResource.count({ where: { conceptId: keptConceptId, resourceId: ids.free } })).toBe(1);
  });

  it('drops the deprecated row from the concept map and regresses the Path', async () => {
    expect(await prisma.conceptResource.count({ where: { conceptId: lostConceptId } })).toBe(0);
    expect(await prisma.path.findUniqueOrThrow({ where: { id: pathId }, select: { status: true } })).toEqual({
      status: PathStatus.building,
    });
  });

  // PROPERTY 4. The repointed row's URL kind now agrees with its page, so the classifier
  // reports no conflict on it; the deprecated row is outside the write window.
  it('finds nothing to do on a second run', async () => {
    const plans = await mine();
    expect([...plans.values()].filter((p) => p.plan.action !== 'escalate')).toEqual([]);
    expect(plans.has(FREE_URL)).toBe(false);
  });
});
