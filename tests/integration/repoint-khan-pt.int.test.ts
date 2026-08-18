// Tests for S9's `/pt/` repoint — the only block in this plan that changes what a row POINTS
// AT, so the properties under test are the three outcomes and the one thing that must not
// happen on any of them:
//
//   1. REPOINTED. The row ends on the YouTube watch URL, typed `video`, carrying the
//      provider's own number stamped `api` — and its ConceptResource links SURVIVE. That
//      last clause is the whole reason this block exists rather than letting S8 deprecate
//      these rows: ten attached SQL lessons ride on it, and a repoint routed through a seam
//      that cleans up links (`applyPendingReview`) would silently destroy them.
//   2. DEPRECATED, video unresolvable — through the reject seam, not left half-edited.
//   3. DEPRECATED, target URL already taken BY A SERVABLE ROW — decided BEFORE the write, so
//      the unique constraint on `Resource.url` is never reached.
//   4. ESCALATED, target URL held by a DEPRECATED row. The fourth outcome, and the one the
//      cross-block review found missing: reading a retired incumbent as an ordinary collision
//      deprecates the `/pt/` row against a copy that cannot serve either, which retires the
//      last copy of the lesson and drops the very concept links this block exists to keep.
//      Both fixtures are seeded — an `active` incumbent and a `deprecated` one — because the
//      whole defect was that only the first existed.
//
// Split by cost as `sweep-serveability.int.test.ts` does: `planFor` is pure, so the outcome
// table is a plain `describe`, and `describeDb` covers only what the seams do to rows.
//
// The DB half never calls `main()` and never touches a row it did not seed: `collectPlans`
// scans the whole table (the population is the classifier's to decide), so every assertion is
// filtered to the marker first. A hand-built probe map and a stub duration resolver are
// passed in rather than reading `docs/audits/` and the YouTube Data API, so the test is
// hermetic on a machine with no probe artifacts, no network and no API key.
//
// Self-cleaning `__verify_s9__` marker; skips cleanly without DATABASE_URL. Run with the
// dockerized workers stopped.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { ConceptResourceRole, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { ProbeEvidence } from '@/lib/curation/serveability-probe';
import {
  applyPlan,
  collectPlans,
  isProjectTask,
  planFor,
  videoIdFor,
  type Holder,
  type Planned,
} from '../../scripts/repoint-khan-pt';
import { describeDb } from './db';

const MARK = '__verify_s9__';
const TOPIC = `${MARK}-topic`;

const pt = (slug: string) => `https://www.khanacademy.org/computing/${MARK}/sql/pt/${slug}`;
const OK_URL = pt('querying-the-table');
const UNRESOLVED_URL = pt('never-probed');
const COLLIDING_URL = pt('already-filed');
const RETIRED_INCUMBENT_URL = pt('held-by-a-retired-row');

const OK_VIDEO = 'S9okVIDEO01';
const DUP_VIDEO = 'S9dupVIDEO2';
const DUP_WATCH_URL = `https://www.youtube.com/watch?v=${DUP_VIDEO}`;
const RETIRED_VIDEO = 'S9retiredV3';
const RETIRED_WATCH_URL = `https://www.youtube.com/watch?v=${RETIRED_VIDEO}`;

// A probe of a `/pt/` page as the artifacts actually record one: `pageKind: 'challenge'`,
// no readable article, exactly one embedded talkthrough video.
const ptProbe = (url: string, videoIds: string[]): ProbeEvidence => ({
  url,
  title: 'A talkthrough',
  pageKind: 'challenge',
  videoIds,
  articleWords: null,
  articleWordsBeforeExpand: null,
  collapsedExpanded: 0,
  workedExamples: null,
  widgets: 0,
  mainWords: 40,
  hasEditor: true,
  blocked: false,
});

// ── the outcome table, pure ────────────────────────────────────────────────────────────────

const row = (over: Partial<Parameters<typeof planFor>[0]> = {}) => ({
  id: 'r1',
  url: OK_URL,
  title: 'Querying the table',
  type: 'interactive' as const,
  status: 'active' as const,
  decompositionStatus: 'atomic' as const,
  durationMin: 20,
  ...over,
});
const durations = new Map([[OK_VIDEO, 214]]);
const outcome = (
  over: Partial<Parameters<typeof planFor>[0]> = {},
  probe: ProbeEvidence | null = ptProbe(OK_URL, [OK_VIDEO]),
  holders = new Map<string, Holder>(),
  claimed = new Map<string, string>(),
) => planFor(row(over), probe, durations, holders, claimed);
const heldBy = (id: string, status: Holder['status']) => new Map([[OK_VIDEO, { id, status }]]);

describe('repoint-khan-pt — the population', () => {
  it('is whatever the shipped classifier says, never a list of ids', () => {
    expect(isProjectTask(OK_URL)).toBe(true);
    expect(isProjectTask('https://www.khanacademy.org/computing/x/sql/v/talkthrough')).toBe(false);
    expect(isProjectTask('https://www.khanacademy.org/computing/x/sql/pi/challenge')).toBe(false);
    // A `/pt/` segment on some other host is not a Khan project task.
    expect(isProjectTask('https://example.invalid/a/pt/thing')).toBe(false);
  });
});

describe('repoint-khan-pt — the three outcomes (pure)', () => {
  it('repoints a row whose single embedded video resolves', () => {
    expect(outcome()).toEqual({
      action: 'repoint',
      videoId: OK_VIDEO,
      url: `https://www.youtube.com/watch?v=${OK_VIDEO}`,
      seconds: 214,
      durationMin: 4,
    });
  });

  it('deprecates a row with no probe artifact — the ungit-ignorable half of the evidence', () => {
    expect(outcome({}, null)).toMatchObject({ action: 'deprecate', reason: 'unresolvable' });
  });

  it('deprecates a row whose video id resolves to no duration', () => {
    const o = outcome({}, ptProbe(OK_URL, ['S9missingXX']));
    expect(o).toMatchObject({ action: 'deprecate', reason: 'unresolvable' });
    expect(o.action === 'deprecate' && o.detail).toContain('S9missingXX');
  });

  // Taking the first of several would move the row permanently onto the wrong lesson.
  it('deprecates a page carrying anything but exactly one video', () => {
    for (const ids of [[], [OK_VIDEO, 'S9otherVID3']]) {
      expect(outcome({}, ptProbe(OK_URL, ids))).toMatchObject({ action: 'deprecate', reason: 'unresolvable' });
    }
    expect(videoIdFor(ptProbe(OK_URL, []))).toEqual({ reason: '0 youtube id(s) in the page, need exactly 1' });
  });

  it('deprecates a row whose target URL is already a servable row', () => {
    for (const status of ['active', 'pending_review'] as const) {
      const o = outcome({}, ptProbe(OK_URL, [OK_VIDEO]), heldBy('other-row', status));
      expect(o).toMatchObject({ action: 'deprecate', reason: 'collision' });
      expect(o.action === 'deprecate' && o.detail).toContain('other-row');
    }
  });

  // The cross-block review's finding. A deprecated incumbent cannot serve the lesson, so
  // deprecating this row against it would retire the last copy — and the unique constraint
  // still forbids the repoint, so neither write is available and the driver refuses both.
  it('escalates rather than deprecating when the target URL is held by a deprecated row', () => {
    const o = outcome({}, ptProbe(OK_URL, [OK_VIDEO]), heldBy('retired-row', 'deprecated'));
    expect(o).toMatchObject({ action: 'escalate', reason: 'deprecated-incumbent' });
    expect(o.action === 'escalate' && o.detail).toContain('retired-row');
  });

  // The escalation outranks the missing duration: the video is in the library either way, and
  // the judgment being deferred is about the incumbent, not about a number.
  it('escalates even when the video resolves to no duration', () => {
    expect(outcome({}, ptProbe(OK_URL, ['S9missingXX']), new Map([['S9missingXX', { id: 'retired-row', status: 'deprecated' as const }]]))).toMatchObject({
      action: 'escalate',
    });
  });

  // Two /pt/ rows on the same clip: the second must not plan a write the first made illegal.
  it('treats a target claimed earlier in the same run as a collision', () => {
    expect(outcome({}, ptProbe(OK_URL, [OK_VIDEO]), new Map(), new Map([[OK_VIDEO, 'earlier-row']]))).toMatchObject({
      action: 'deprecate',
      reason: 'collision',
    });
  });

  it('does not read its own claim as a collision', () => {
    expect(outcome({ id: 'r1' }, ptProbe(OK_URL, [OK_VIDEO]), heldBy('r1', 'active'))).toMatchObject({
      action: 'repoint',
    });
  });

  it('never re-decides an already-deprecated row', () => {
    expect(outcome({ status: 'deprecated' })).toMatchObject({ action: 'skip', reason: 'already-decided' });
  });

  it('declines a row that is not atomic — both seams require one', () => {
    expect(outcome({ decompositionStatus: 'pending' })).toMatchObject({ action: 'skip', reason: 'not-atomic' });
  });
});

// ── the write seams ────────────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

describeDb('repoint-khan-pt — the write seams (S9)', () => {
  let ids: Record<string, string>;
  let pathId: string;
  let okConceptId: string;
  let deprecatedConceptId: string;
  let escalatedConceptId: string;
  let probes: Map<string, ProbeEvidence | null>;

  const seed = async (
    sourceId: string,
    slug: string,
    url: string,
    type: 'interactive' | 'video',
    status: 'active' | 'deprecated' = 'active',
  ) =>
    (
      await prisma.resource.create({
        data: {
          slug: `${MARK}-${slug}`,
          topic: TOPIC,
          title: `S9 ${slug}`,
          url,
          type,
          durationMin: 20,
          durationSource: 'estimated',
          summary: 'S9 repoint fixture',
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
  const mine = async (): Promise<Map<string, Planned>> => {
    const planned = await collectPlans(
      probes,
      // `RETIRED_VIDEO` resolves fine — so the only reason its row is not repointed is the
      // incumbent sitting on the URL, which is the thing under test.
      async () => new Map([[OK_VIDEO, 214], [RETIRED_VIDEO, 300]]),
    );
    return new Map(planned.filter((p) => p.row.url.includes(MARK)).map((p) => [p.row.url, p]));
  };
  // `main()`'s own filter: an escalation is never offered to `applyPlan`, so a run cannot
  // action a row the driver refused to decide.
  const runDriver = async () => {
    const applied: string[] = [];
    for (const p of (await mine()).values()) {
      if (p.outcome.action !== 'repoint' && p.outcome.action !== 'deprecate') continue;
      const result = await applyPlan(p);
      expect(result.ok).toBe(true);
      applied.push(p.outcome.action);
    }
    return applied.sort();
  };
  const rowById = (id: string) =>
    prisma.resource.findUniqueOrThrow({
      where: { id },
      select: { url: true, type: true, status: true, deprecationSeverity: true, durationMin: true, durationSource: true },
    });

  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${MARK}-src`, name: 'S9 source', url: 'https://www.khanacademy.org', kind: 'community' },
      select: { id: true },
    });
    ids = {
      ok: await seed(source.id, 'ok', OK_URL, 'interactive'),
      unresolved: await seed(source.id, 'unresolved', UNRESOLVED_URL, 'interactive'),
      colliding: await seed(source.id, 'colliding', COLLIDING_URL, 'interactive'),
      // The row that owns the colliding row's target URL already — a perfectly good video
      // resource the repoint must not be allowed to write over.
      incumbent: await seed(source.id, 'incumbent', DUP_WATCH_URL, 'video'),
      // The same shape with a RETIRED incumbent. The URL is just as taken, but nothing here
      // can serve the lesson, so the `/pt/` row is the last copy of it.
      heldByRetired: await seed(source.id, 'held-by-retired', RETIRED_INCUMBENT_URL, 'interactive'),
      retiredIncumbent: await seed(source.id, 'retired-incumbent', RETIRED_WATCH_URL, 'video', 'deprecated'),
    };

    // Two concepts on one spine-ready Path: one covered by the row about to be REPOINTED (its
    // link must survive) and one covered only by the row about to be DEPRECATED (its link must
    // go, and the Path must regress).
    pathId = (await prisma.path.create({ data: { topic: TOPIC, status: PathStatus.spine_ready }, select: { id: true } })).id;
    okConceptId = (
      await prisma.concept.create({ data: { pathId, slug: `${MARK}-c-ok`, title: 'S9 kept' }, select: { id: true } })
    ).id;
    deprecatedConceptId = (
      await prisma.concept.create({ data: { pathId, slug: `${MARK}-c-gone`, title: 'S9 lost' }, select: { id: true } })
    ).id;
    await prisma.conceptResource.create({
      data: { conceptId: okConceptId, resourceId: ids.ok, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
    });
    await prisma.conceptResource.create({
      data: {
        conceptId: deprecatedConceptId,
        resourceId: ids.unresolved,
        role: ConceptResourceRole.teaches,
        coverageScore: 0.9,
      },
    });
    // The escalated row is attached too, and that is the point: the defect this fixture
    // encodes destroyed exactly this link.
    escalatedConceptId = (
      await prisma.concept.create({ data: { pathId, slug: `${MARK}-c-held`, title: 'S9 held' }, select: { id: true } })
    ).id;
    await prisma.conceptResource.create({
      data: {
        conceptId: escalatedConceptId,
        resourceId: ids.heldByRetired,
        role: ConceptResourceRole.teaches,
        coverageScore: 0.9,
      },
    });

    // Only the probed rows have a page. `unresolved` has none — the production case of a
    // `/pt/` row that no batch file covers.
    probes = new Map([
      [ids.ok, ptProbe(OK_URL, [OK_VIDEO])],
      [ids.colliding, ptProbe(COLLIDING_URL, [DUP_VIDEO])],
      [ids.heldByRetired, ptProbe(RETIRED_INCUMBENT_URL, [RETIRED_VIDEO])],
    ]);
  });
  afterAll(cleanup);

  it('plans one outcome per /pt/ row and ignores the incumbent video row', async () => {
    const plans = await mine();
    expect(plans.get(OK_URL)?.outcome).toMatchObject({ action: 'repoint', videoId: OK_VIDEO, durationMin: 4 });
    expect(plans.get(UNRESOLVED_URL)?.outcome).toMatchObject({ action: 'deprecate', reason: 'unresolvable' });
    // The collision is found by reading the table, not by catching a constraint error.
    expect(plans.get(COLLIDING_URL)?.outcome).toMatchObject({ action: 'deprecate', reason: 'collision' });
    expect(plans.get(COLLIDING_URL)?.outcome).toMatchObject({ detail: expect.stringContaining(ids.incumbent) });
    // The same table read, one status apart: a DEPRECATED incumbent is an escalation, never
    // the collision that would deprecate this row against a copy nobody can be served.
    expect(plans.get(RETIRED_INCUMBENT_URL)?.outcome).toMatchObject({
      action: 'escalate',
      reason: 'deprecated-incumbent',
      detail: expect.stringContaining(ids.retiredIncumbent),
    });
    expect(plans.has(DUP_WATCH_URL)).toBe(false);
    // The point of the block: the repointed and escalated rows are both attached ones.
    expect(plans.get(OK_URL)?.attached).toBe(true);
    expect(plans.get(RETIRED_INCUMBENT_URL)?.attached).toBe(true);
  });

  it('applies each outcome through its own seam, and raises no unique-constraint error', async () => {
    expect(await runDriver()).toEqual(['deprecate', 'deprecate', 'repoint']);

    expect(await rowById(ids.ok)).toEqual({
      url: `https://www.youtube.com/watch?v=${OK_VIDEO}`,
      type: 'video',
      status: 'active',
      deprecationSeverity: null,
      durationMin: 4,
      durationSource: 'api',
    });

    for (const id of [ids.unresolved, ids.colliding]) {
      expect(await rowById(id)).toMatchObject({ status: 'deprecated', deprecationSeverity: 'soft' });
    }
    // Never deleted — a Resource is referenced by ratings, reports and Lesson snapshots.
    expect(await prisma.resource.count({ where: { id: { in: [ids.unresolved, ids.colliding] } } })).toBe(2);
    // The incumbent kept its URL: the collision was declined, not resolved in the newcomer's
    // favour.
    expect(await rowById(ids.incumbent)).toMatchObject({ url: DUP_WATCH_URL, status: 'active' });

    // The escalated row is untouched on every axis — still `/pt/`, still active, still
    // carrying its old duration — and so is the retired incumbent. An escalation writes
    // nothing, which is what leaves both rows as recoverable as they were.
    expect(await rowById(ids.heldByRetired)).toMatchObject({
      url: RETIRED_INCUMBENT_URL,
      type: 'interactive',
      status: 'active',
      durationMin: 20,
      durationSource: 'estimated',
    });
    expect(await rowById(ids.retiredIncumbent)).toMatchObject({
      url: RETIRED_WATCH_URL,
      status: 'deprecated',
    });
  });

  // The defect the cross-block review found, asserted where it would have shown: deprecating
  // the escalated row would have dropped this link and left the lesson servable from neither
  // row.
  it('keeps the escalated row attached to its concept', async () => {
    expect(
      await prisma.conceptResource.count({ where: { conceptId: escalatedConceptId, resourceId: ids.heldByRetired } }),
    ).toBe(1);
  });

  // THE property of this block. A repoint is a field update precisely because
  // `applyPendingReview` would have dropped these links.
  it('keeps the repointed row attached to its concept', async () => {
    expect(
      await prisma.conceptResource.count({ where: { conceptId: okConceptId, resourceId: ids.ok } }),
    ).toBe(1);
  });

  it('drops the deprecated row from the concept map and regresses the Path', async () => {
    expect(await prisma.conceptResource.count({ where: { conceptId: deprecatedConceptId } })).toBe(0);
    expect((await prisma.path.findUniqueOrThrow({ where: { id: pathId } })).status).toBe(PathStatus.building);
  });

  it('finds nothing to repoint on a second run, and writes nothing', async () => {
    const plans = await mine();
    // The repointed row left the population entirely — its URL is no longer a /pt/ URL.
    expect(plans.has(OK_URL)).toBe(false);
    expect(
      [...plans.values()].filter((p) => p.outcome.action === 'repoint' || p.outcome.action === 'deprecate'),
    ).toEqual([]);
    expect(plans.get(UNRESOLVED_URL)?.outcome).toMatchObject({ action: 'skip', reason: 'already-decided' });
    // The escalation is STANDING, not consumed: nothing was written, so the row is in exactly
    // the state that produced it and will keep being reported until a human resolves it.
    // Idempotence here means "no second helping of writes", not "the finding goes away".
    expect(plans.get(RETIRED_INCUMBENT_URL)?.outcome).toMatchObject({ action: 'escalate' });
    expect(await runDriver()).toEqual([]);
  });
});
