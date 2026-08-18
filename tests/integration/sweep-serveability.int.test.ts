// Tests for S8's library sweep — the first block in this plan that writes to production
// data, so the two properties under test are the two that make that safe:
//
//   1. THE THREE-WAY PRECEDENCE, decompose > re-type > deprecate. It is enforced in the
//      driver rather than left to the operator, and every one of its edges is a row that
//      would otherwise be destroyed: a container queued for decompose still matches
//      `interactive-type` (pending is not decomposed), and a row wearing a stale label still
//      matches the clause-5 rule it is being corrected out of.
//   2. IDEMPOTENCE. A second `--apply` must find nothing and write nothing, which is what
//      makes re-running the sweep after a classifier change a safe operation rather than a
//      second helping of damage.
//
// Split by cost, on purpose. `analyse` and `planFor` are pure, so the precedence table is a
// plain `describe` needing no database — every edge is cheap to assert there and each case
// reads as the rule it encodes. `describeDb` covers only what the seams actually do to rows:
// the writes, the ConceptResource cleanup, the readiness recompute, and the no-op second run.
//
// The DB half never calls the driver's own `main()` and never touches a row it did not seed:
// `collectPlans` scans the whole table (the population is the classifiers' to decide), so
// every assertion and every apply is filtered to the marker first. A hand-built probe map is
// passed in rather than reading `docs/audits/`, so the test is hermetic on a machine with no
// probe artifacts.
//
// Self-cleaning `__verify_s8__` marker; skips cleanly without DATABASE_URL. Run with the
// dockerized workers stopped.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { ConceptResourceRole, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { ProbeEvidence } from '@/lib/curation/serveability-probe';
import {
  analyse,
  applyPlan,
  collectPlans,
  planFor,
  type Planned,
} from '../../scripts/sweep-serveability';
import { describeDb } from './db';

const MARK = '__verify_s8__';
const TOPIC = `${MARK}-topic`;
const HOST = 'https://s8.example.invalid';

const RETYPE_URL = `${HOST}/${MARK}/stale-label`;
const DEPRECATE_URL = `${HOST}/${MARK}/widget`;
const PT_URL = `https://www.khanacademy.org/computing/${MARK}/pt/talkthrough`;
const PRECEDENCE_URL = `https://www.khanacademy.org/math/${MARK}/a/mislabelled`;
const EDX_URL =
  `https://openlearninglibrary.mit.edu/courses/course-v1:MITx+${MARK}` +
  `/jump_to/block-v1:MITx+${MARK}+type@sequential+block@intro`;
const CLEAN_URL = `${HOST}/${MARK}/good-lesson`;

// A probe of a page that reads as a substantial article: well over the prose floor, no
// widgets, no editor, no chain marker — so every probe-level serveability rule declines and
// the only thing it says about the row is clause 6's, which is the point of the fixture.
const articleProbe = (url: string, title: string): ProbeEvidence => ({
  url,
  title,
  pageKind: 'article',
  videoIds: [],
  articleWords: 900,
  articleWordsBeforeExpand: 900,
  collapsedExpanded: 0,
  workedExamples: 0,
  widgets: 0,
  mainWords: 1100,
  hasEditor: false,
  blocked: false,
});

// ── the precedence table, pure ─────────────────────────────────────────────────────────────

const row = (over: Partial<Parameters<typeof analyse>[0]> = {}) => ({
  id: 'r1',
  url: `${HOST}/lesson`,
  title: 'A lesson',
  type: 'article' as const,
  status: 'active' as const,
  decompositionStatus: 'atomic' as const,
  durationMin: 30,
  durationSource: 'estimated' as const,
  ...over,
});
const plan = (over: Partial<Parameters<typeof analyse>[0]> = {}, probe: ProbeEvidence | null = null) =>
  planFor(analyse(row(over), probe, false));

describe('sweep-serveability — the three-way precedence (pure)', () => {
  // decompose > deprecate. Without it the sweep would deprecate the very rows it queued: a
  // container-URL row is `interactive`, and `interactive-type` fires on anything that is not
  // explicitly `decomposed`.
  it('queues a Khan unit page for decompose rather than deprecating it', () => {
    const p = plan({
      url: 'https://www.khanacademy.org/math/statistics-probability/probability-library/bayes-theorem',
      type: 'interactive',
    });
    expect(p).toMatchObject({ action: 'decompose', rule: 'khan-container-url' });
  });

  it('queues an edX sequential unit for decompose — clause 3 on a host no classifier covers', () => {
    expect(plan({ url: EDX_URL, type: 'interactive' })).toMatchObject({
      action: 'decompose',
      rule: 'edx-sequential-url',
    });
  });

  // re-type > deprecate: the row fails clause 5 on `interactive` AND carries a clause-6
  // finding naming what it should have been. The repair wins.
  it('re-types a mislabelled row instead of deprecating it on the stale type', () => {
    expect(plan({ url: PRECEDENCE_URL, type: 'interactive' })).toMatchObject({
      action: 'retype',
      to: 'article',
    });
  });

  it('deprecates a serveability failure with nothing to repair', () => {
    expect(plan({ url: `${HOST}/viz`, type: 'interactive' })).toMatchObject({
      action: 'deprecate',
    });
  });

  it('skips Khan /pt/ entirely — S9 repoints those', () => {
    expect(plan({ url: PT_URL, type: 'interactive' })).toEqual({ action: 'none', reason: 'khan-pt' });
  });

  // S4 deliberately picks no winner between two re-type targets, and neither may the sweep —
  // including by falling through to the deprecation the row is otherwise eligible for.
  it('refuses a row whose two re-type findings name different targets', () => {
    // The production row this encodes: a `/a/` URL (so the URL says `article`) that now
    // serves, and declares itself, a video. Two `retype` findings, two targets, no winner.
    const url = 'https://www.khanacademy.org/math/linear-algebra/x/a/linear-combinations-and-span';
    const probe = { ...articleProbe(url.replace('/a/', '/v/'), 'Linear combinations and span'), pageKind: 'video' };
    expect(plan({ url, title: 'Linear combinations and span', type: 'interactive' }, probe)).toEqual({
      action: 'none',
      reason: 'retype-target-conflict',
    });
  });

  it('leaves a clean row alone', () => {
    expect(plan()).toEqual({ action: 'none', reason: 'clean' });
  });

  it('never re-decides an already-deprecated row', () => {
    expect(plan({ url: `${HOST}/viz`, type: 'interactive', status: 'deprecated' })).toEqual({
      action: 'none',
      reason: 'already-decided',
    });
  });

  // A row already in the decomposition queue is not a deprecation candidate — this is the
  // second half of the decompose precedence, and `applyPendingReview` refuses it too.
  it('never deprecates a row whose shape is still unsettled', () => {
    expect(plan({ url: `${HOST}/viz`, type: 'interactive', decompositionStatus: 'pending' })).toEqual({
      action: 'none',
      reason: 'in-decomposition-queue',
    });
  });

  // A probe is keyed by resourceId, so it describes the page the row pointed at WHEN PROBED.
  // Letting a stale one answer a serveability question answers it about somebody else's page.
  describe('a probe only decides about the row it actually describes', () => {
    // The Khan challenge page S9 repoints away from: an in-browser editor and nothing to
    // read, which is `editor-no-prose` on any row it is allowed to judge.
    const TITLE = 'Challenge: bouncing ball';
    const challengeProbe = (url: string): ProbeEvidence => ({
      ...articleProbe(url, TITLE),
      pageKind: 'challenge',
      articleWords: null,
      articleWordsBeforeExpand: null,
      mainWords: null,
      hasEditor: true,
    });
    // Titles held equal throughout so clause 6's title comparison stays out of the way; each
    // case below is about the URL disagreement it names, nothing else.
    const STORED = 'https://www.khanacademy.org/computing/sql/a/creating-a-table';
    const judge = (url: string, probeUrl: string, type: 'article' | 'video' = 'article') =>
      analyse(row({ url, title: TITLE, type }), challengeProbe(probeUrl), false);

    // The regression this check exists for. Sequence: sweep --apply, repoint --apply, sweep
    // again — and before the fix the second sweep deprecated the ten attached SQL lessons S9
    // had just rescued, because the repointed row still carried its Khan challenge probe.
    it('does not deprecate a repointed row still carrying its old Khan probe', () => {
      const a = judge(
        'https://www.youtube.com/watch?v=abc123',
        'https://www.khanacademy.org/computing/sql/pt/challenge-book-list',
        'video',
      );
      expect(a).toMatchObject({ probeVoided: true, failures: [] });
      expect(planFor(a)).toEqual({ action: 'none', reason: 'clean' });
    });

    // The other half of the same bug: the landed page belongs to different content, which is
    // exactly what `url-redirects-across-kinds` says — so it cannot also be the evidence that
    // condemns the row.
    it('withholds a verdict when the stored URL now serves a different content kind', () => {
      const a = judge(STORED, STORED.replace('/a/', '/pt/'));
      expect(a).toMatchObject({
        probeVoided: true,
        failures: [],
        // Clause 6 still sees the redirect and still reports it — voiding the SERVEABILITY
        // verdict must not delete the finding that explains the row.
        discrepancies: [{ kind: 'url-redirects-across-kinds', repair: 'review' }],
      });
      expect(planFor(a)).toEqual({ action: 'none', reason: 'review-only' });
    });

    it('voids a probe whose host disagrees, even at the same content kind', () => {
      const a = judge(STORED, 'https://example.invalid/x/a/creating-a-table');
      expect(a).toMatchObject({ probeVoided: true, failures: [] });
    });

    // ⚠️ Slug drift is normal and common on Khan, and voiding on it would silently discard
    // most of the page evidence the library has. Only kind and host disagreement void.
    it('still counts a probe that merely drifted slug', () => {
      const a = judge(STORED, `${STORED}-and-inserting-data`);
      expect(a.probeVoided).toBe(false);
      expect(planFor(a)).toMatchObject({ action: 'deprecate', rule: '5:editor-no-prose' });
    });

    it('still counts a probe that landed on exactly this page', () => {
      const a = judge(STORED, STORED);
      expect(a.probeVoided).toBe(false);
      expect(planFor(a)).toMatchObject({ action: 'deprecate', rule: '5:editor-no-prose' });
    });
  });

  describe('a re-type clears a duration only when the re-type itself makes it wrong', () => {
    const khanVideoUrl = 'https://www.khanacademy.org/math/x/v/bayes-theorem';

    it('clears a container-form duration', () => {
      expect(plan({ url: khanVideoUrl, type: 'course', durationMin: 45 })).toMatchObject({
        action: 'retype',
        to: 'video',
        clearDuration: true,
      });
    });

    it('keeps a duration measured against this same single page (article → video)', () => {
      expect(plan({ url: khanVideoUrl, type: 'article', durationMin: 7 })).toMatchObject({
        action: 'retype',
        clearDuration: false,
      });
    });

    it('never overwrites an authoritative measurement', () => {
      for (const durationSource of ['api', 'reviewer'] as const) {
        expect(plan({ url: khanVideoUrl, type: 'course', durationMin: 45, durationSource })).toMatchObject({
          action: 'retype',
          clearDuration: false,
        });
      }
    });
  });
});

// ── the write seams ────────────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

describeDb('sweep-serveability — the write seams (S8)', () => {
  let ids: Record<string, string>;
  let pathId: string;
  let conceptId: string;
  let probes: Map<string, ProbeEvidence | null>;
  let fingerprintBefore: string;

  const seed = async (
    sourceId: string,
    slug: string,
    url: string,
    type: 'interactive' | 'article',
    durationMin: number | null,
  ) =>
    (
      await prisma.resource.create({
        data: {
          slug: `${MARK}-${slug}`,
          topic: TOPIC,
          title: `S8 ${slug}`,
          url,
          type,
          durationMin,
          durationSource: durationMin === null ? 'unknown' : 'estimated',
          summary: 'S8 sweep fixture',
          difficulty: 'beginner',
          status: 'active',
          decompositionStatus: 'atomic',
          origin: 'agent',
          prerequisiteConcepts: [],
          conceptsTaught: [],
          sourceId,
        },
        select: { id: true },
      })
    ).id;

  // Tracks are immutable and this sweep must leave them so — counted rather than argued from
  // the code path, exactly as `deprecate-furniture.ts --tracks` does.
  const trackFingerprint = async () =>
    JSON.stringify([
      await prisma.track.count(),
      await prisma.lesson.count(),
      await prisma.lessonResource.count(),
      (await prisma.track.aggregate({ _max: { updatedAt: true } }))._max.updatedAt,
      (await prisma.lesson.aggregate({ _max: { updatedAt: true } }))._max.updatedAt,
      // LessonResource carries no updatedAt column, so its count is the whole signal there.
      (await prisma.lessonResource.aggregate({ _max: { createdAt: true } }))._max.createdAt,
    ]);

  // Only ever the rows this file seeded: `collectPlans` reads the whole table by design.
  const mine = async (): Promise<Map<string, Planned>> => {
    const planned = await collectPlans(probes);
    return new Map(
      planned.filter((p) => p.analysis.row.url.includes(MARK)).map((p) => [p.analysis.row.url, p]),
    );
  };
  const runSweep = async () => {
    const applied: string[] = [];
    for (const p of (await mine()).values()) {
      if (p.plan.action === 'none') continue;
      const outcome = await applyPlan(p);
      expect(outcome.ok).toBe(true);
      applied.push(p.plan.action);
    }
    return applied.sort();
  };
  const rowByUrl = (url: string) =>
    prisma.resource.findUniqueOrThrow({
      where: { url },
      select: {
        type: true,
        status: true,
        deprecationSeverity: true,
        decompositionStatus: true,
        durationMin: true,
        durationSource: true,
      },
    });

  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${MARK}-src`, name: 'S8 source', url: HOST, kind: 'community' },
      select: { id: true },
    });
    ids = {
      retype: await seed(source.id, 'stale-label', RETYPE_URL, 'interactive', 30),
      deprecate: await seed(source.id, 'widget', DEPRECATE_URL, 'interactive', 20),
      pt: await seed(source.id, 'pt', PT_URL, 'interactive', 20),
      precedence: await seed(source.id, 'precedence', PRECEDENCE_URL, 'interactive', 25),
      edx: await seed(source.id, 'edx', EDX_URL, 'interactive', 60),
      clean: await seed(source.id, 'good', CLEAN_URL, 'article', 30),
    };

    // A legitimately spine-ready Path whose single spine concept is covered ONLY by the row
    // about to be deprecated, so the readiness recompute has something to regress.
    const path = await prisma.path.create({
      data: { topic: TOPIC, status: PathStatus.spine_ready },
      select: { id: true },
    });
    pathId = path.id;
    const concept = await prisma.concept.create({
      data: { pathId, slug: `${MARK}-concept`, title: 'S8 concept' },
      select: { id: true },
    });
    conceptId = concept.id;
    await prisma.conceptResource.create({
      data: { conceptId, resourceId: ids.deprecate, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
    });

    // The page evidence, keyed by the ids the seed just produced. Only the re-type fixture
    // has a page: everything else is decided from stored fields alone.
    probes = new Map([[ids.retype, articleProbe(RETYPE_URL, `S8 stale-label`)]]);
    fingerprintBefore = await trackFingerprint();
  });
  afterAll(cleanup);

  it('plans one repair per seeded row, and nothing for the good one', async () => {
    const plans = await mine();
    expect(plans.get(RETYPE_URL)?.plan).toMatchObject({ action: 'retype', to: 'article', clearDuration: true });
    expect(plans.get(PRECEDENCE_URL)?.plan).toMatchObject({ action: 'retype', to: 'article' });
    expect(plans.get(EDX_URL)?.plan).toMatchObject({ action: 'decompose' });
    expect(plans.get(DEPRECATE_URL)?.plan).toMatchObject({ action: 'deprecate' });
    expect(plans.get(PT_URL)?.plan).toEqual({ action: 'none', reason: 'khan-pt' });
    expect(plans.get(CLEAN_URL)?.plan).toEqual({ action: 'none', reason: 'clean' });
  });

  it('applies each repair through its own seam', async () => {
    expect(await runSweep()).toEqual(['decompose', 'deprecate', 'retype', 'retype']);

    // Re-typed on the page's evidence, NOT deprecated on the stale type it carried — and the
    // container-form duration went with the old label rather than staying attached as a
    // promise the new form cannot keep.
    expect(await rowByUrl(RETYPE_URL)).toMatchObject({
      type: 'article',
      status: 'active',
      deprecationSeverity: null,
      durationMin: null,
      durationSource: 'unknown',
    });
    expect(await rowByUrl(PRECEDENCE_URL)).toMatchObject({ type: 'article', status: 'active' });

    // ⚠️ `type` is deliberately still `interactive`: it is a CONTAINER_TYPE, which is what
    // makes `classify()` fetch the page instead of short-circuiting to atomic. Only the
    // decomposition status moved, and the row was not deprecated on its type either.
    expect(await rowByUrl(EDX_URL)).toMatchObject({
      type: 'interactive',
      status: 'active',
      decompositionStatus: 'pending',
    });

    expect(await rowByUrl(DEPRECATE_URL)).toMatchObject({
      status: 'deprecated',
      deprecationSeverity: 'soft',
    });
    expect(await rowByUrl(PT_URL)).toMatchObject({ status: 'active', type: 'interactive' });
    expect(await rowByUrl(CLEAN_URL)).toMatchObject({ status: 'active', type: 'article' });
  });

  // The whole reason removals go through `applyPendingReview` rather than a status write: a
  // row deprecated by hand stays in every live concept map's candidate pool, invisible to
  // retrieval but still placed.
  it('drops the deprecated row from the concept map and regresses the Path', async () => {
    expect(await prisma.conceptResource.count({ where: { conceptId } })).toBe(0);
    expect((await prisma.path.findUniqueOrThrow({ where: { id: pathId } })).status).toBe(
      PathStatus.building,
    );
  });

  it('finds nothing to do on a second run, and writes nothing', async () => {
    const plans = await mine();
    expect([...plans.values()].filter((p) => p.plan.action !== 'none')).toEqual([]);
    // The decomposed row is the one that could regress here: it still matches
    // `interactive-type`, and only the queue check keeps the sweep off it.
    expect(plans.get(EDX_URL)?.plan).toEqual({ action: 'none', reason: 'in-decomposition-queue' });
    expect(plans.get(DEPRECATE_URL)?.plan).toEqual({ action: 'none', reason: 'already-decided' });

    expect(await runSweep()).toEqual([]);
    expect(await rowByUrl(EDX_URL)).toMatchObject({ status: 'active', decompositionStatus: 'pending' });
  });

  it('writes no Track, Lesson or LessonResource row', async () => {
    expect(await trackFingerprint()).toBe(fingerprintBefore);
  });
});
