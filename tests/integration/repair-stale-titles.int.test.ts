// Tests for clause 6's title-repair driver. Four properties, and the second is the one the
// driver is built around:
//
//   1. THE CANDIDATE COMES FROM THE SHIPPED SEAM. `crediblePageTitle` owns the interstitial
//      list and the shared-word anchor, so a bot-wall title can never become a stored title
//      and a page title sharing nothing with the row is declined rather than trusted.
//   2. A CANDIDATE THAT DOES NOT CLEAR THE FINDING IS NOT WRITTEN. The two modules fold a
//      title differently, so a candidate can be a genuine improvement and still leave
//      comparison 4 firing — which would rewrite and re-embed the row on every pass forever.
//      Verifying against the classifier rather than against the driver's own idea of equality
//      is what makes idempotence structural.
//   3. THE SECOND CANDIDATE IS GATED ON THE URL'S CONTENT KIND. On a `/a/` or `/v/` URL the
//      first segment is the lesson's own name; on a unit page reducing to it makes the record
//      LESS accurate, which would be a clause-6 defect created by a clause-6 repair.
//   4. THE SEAM PRESERVES ATTACHMENT. A retitle is a field update, so the row keeps its
//      ConceptResource links — 51 of the production rows are attached, and routing this
//      through `applyPendingReview` would drop every one of them.
//
// Split by cost as its sibling drivers' tests are: `planFor` is pure, so the outcome table is
// a plain `describe`, and `describeDb` covers only what the seam does to rows.
//
// The DB half never calls `main()` and never touches a row it did not seed: `collectPlans`
// scans the whole table (the population is the classifier's to decide), so every assertion is
// filtered to the marker first. A hand-built probe map is passed in rather than reading
// `docs/audits/`, so the test is hermetic on a machine with no probe artifacts.
//
// Self-cleaning `__verify_c6__` marker; skips cleanly without DATABASE_URL. Run with the
// dockerized workers stopped.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { ConceptResourceRole, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { ProbeEvidence } from '@/lib/curation/serveability-probe';
import { applyPlan, collectPlans, planFor, type Planned } from '../../scripts/repair-stale-titles';
import { describeDb } from './db';

const MARK = '__verify_c6__';
const TOPIC = `${MARK}-topic`;

const video = (slug: string) => `https://www.khanacademy.org/math/${MARK}/unit/v/${slug}`;
const UNIT_URL = `https://www.khanacademy.org/math/${MARK}/unit`;

const PLAIN_URL = video('introducing-limits');
const SECTIONED_URL = video('welcome-to-sql');
const ANCHORLESS_URL = video('probability-decisions');

// A probe as the artifacts record one. `title` is the page's raw <title>, which is what the
// repair reads and what comparison 4 compares against.
const probeOf = (url: string, title: string): ProbeEvidence => ({
  url,
  title,
  pageKind: 'video',
  videoIds: ['C6vidID0001'],
  articleWords: null,
  articleWordsBeforeExpand: null,
  collapsedExpanded: 0,
  workedExamples: null,
  widgets: 0,
  mainWords: 2000,
  hasEditor: false,
  blocked: false,
});

// ── the outcome table, pure ────────────────────────────────────────────────────────────────

const row = (over: Partial<Parameters<typeof planFor>[0]> = {}) => ({
  id: 'r1',
  url: PLAIN_URL,
  title: 'Define limits and use limit notation',
  type: 'video' as const,
  status: 'active' as const,
  ...over,
});

describe('repair-stale-titles — the outcomes (pure)', () => {
  it('adopts a two-segment page title verbatim once the site name is trimmed', () => {
    expect(planFor(row(), probeOf(PLAIN_URL, 'Introducing limits (video) | Khan Academy'))).toEqual({
      action: 'retitle',
      to: 'Introducing limits',
    });
  });

  // PROPERTY 2 + 3. `cleanPageTitle` would keep `Welcome to SQL | SQL basics`, which does not
  // clear comparison 4; the gated second candidate reduces to the lesson's own name.
  it('falls back to the lesson segment when the section would leave the finding firing', () => {
    const p = planFor(
      row({ url: SECTIONED_URL, title: 'SQL basics' }),
      probeOf(SECTIONED_URL, 'Welcome to SQL (video) | SQL basics | Khan Academy'),
    );
    expect(p).toEqual({ action: 'retitle', to: 'Welcome to SQL' });
  });

  // PROPERTY 3. The same title shape on a unit URL: reducing to `Functions` would clear the
  // finding by making the record less accurate, so the row stays on the review list.
  it('refuses the lesson segment on a URL Khan does not mark as one lesson', () => {
    const p = planFor(
      row({ url: UNIT_URL, title: 'Functions | Algebra 1' }),
      probeOf(UNIT_URL, 'Functions | Algebra 1 | Math | Khan Academy'),
    );
    expect(p).toMatchObject({ action: 'skip' });
  });

  // PROPERTY 1. Khan serves a 200 titled "Client Challenge" behind its bot wall. Trusting it
  // would overwrite a good title with bot-wall text and re-embed the row onto it.
  it('never adopts an interstitial title', () => {
    expect(planFor(row(), probeOf(PLAIN_URL, 'Client Challenge'))).toMatchObject({ action: 'skip' });
  });

  // PROPERTY 1. A weak signal never decides alone: a page title sharing no content word with
  // the stored title or the URL's own path is not evidence about this row.
  it('declines a page title anchored to neither the stored title nor the URL', () => {
    const p = planFor(
      row({ url: ANCHORLESS_URL, title: 'Sampling methods' }),
      probeOf(ANCHORLESS_URL, 'Picking fairly (video) | Sampling methods | Khan Academy'),
    );
    expect(p).toMatchObject({ action: 'skip' });
  });

  it('never re-decides a deprecated row', () => {
    expect(planFor(row({ status: 'deprecated' }), probeOf(PLAIN_URL, 'Introducing limits (video) | Khan Academy')))
      .toMatchObject({ action: 'skip', reason: expect.stringContaining('deprecated') });
  });
});

// ── the write seam ─────────────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

describeDb('repair-stale-titles — the write seam', () => {
  let ids: Record<string, string>;
  let pathId: string;
  let conceptId: string;
  let probes: Map<string, ProbeEvidence | null>;

  const seed = async (sourceId: string, slug: string, url: string, title: string) =>
    (
      await prisma.resource.create({
        data: {
          slug: `${MARK}-${slug}`,
          topic: TOPIC,
          title,
          url,
          type: 'video',
          durationMin: 9,
          durationSource: 'estimated',
          summary: 'C6 title fixture',
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

  // Never the whole table: `collectPlans` reads every row by design.
  const mine = async (): Promise<Map<string, Planned>> =>
    new Map(
      (await collectPlans(probes)).filter((p) => p.row.url.includes(MARK)).map((p) => [p.row.url, p]),
    );

  beforeAll(async () => {
    await cleanup();
    const source = await prisma.source.create({
      data: { slug: `${MARK}-src`, name: 'C6 source', url: 'https://www.khanacademy.org', kind: 'community' },
      select: { id: true },
    });
    ids = {
      plain: await seed(source.id, 'plain', PLAIN_URL, 'Define limits and use limit notation'),
      sectioned: await seed(source.id, 'sectioned', SECTIONED_URL, 'SQL basics'),
      anchorless: await seed(source.id, 'anchorless', ANCHORLESS_URL, 'Sampling methods'),
    };

    pathId = (await prisma.path.create({ data: { topic: TOPIC, status: PathStatus.spine_ready }, select: { id: true } })).id;
    conceptId = (
      await prisma.concept.create({ data: { pathId, slug: `${MARK}-c`, title: 'C6 concept' }, select: { id: true } })
    ).id;
    await prisma.conceptResource.create({
      data: { conceptId, resourceId: ids.plain, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
    });

    probes = new Map([
      [ids.plain, probeOf(PLAIN_URL, 'Introducing limits (video) | Khan Academy')],
      [ids.sectioned, probeOf(SECTIONED_URL, 'Welcome to SQL (video) | SQL basics | Khan Academy')],
      [ids.anchorless, probeOf(ANCHORLESS_URL, 'Picking fairly (video) | Sampling methods | Khan Academy')],
    ]);
  });
  afterAll(cleanup);

  it('plans a repair only for the rows a candidate settles', async () => {
    const plans = await mine();
    expect(plans.get(PLAIN_URL)?.plan).toEqual({ action: 'retitle', to: 'Introducing limits' });
    expect(plans.get(SECTIONED_URL)?.plan).toEqual({ action: 'retitle', to: 'Welcome to SQL' });
    expect(plans.get(ANCHORLESS_URL)?.plan).toMatchObject({ action: 'skip' });
  });

  it('writes the title through updateResource and flags the row for re-embedding', async () => {
    for (const p of (await mine()).values()) {
      if (p.plan.action !== 'retitle') continue;
      expect(await applyPlan(p)).toMatchObject({ ok: true, detail: expect.stringContaining('re-embed pending') });
    }

    expect(await prisma.resource.findUniqueOrThrow({ where: { id: ids.plain }, select: { title: true } })).toEqual({
      title: 'Introducing limits',
    });
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: ids.sectioned }, select: { title: true } })).toEqual({
      title: 'Welcome to SQL',
    });
    // The declined row is untouched — a skip writes nothing.
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: ids.anchorless }, select: { title: true } })).toEqual({
      title: 'Sampling methods',
    });
  });

  // PROPERTY 4. A retitle is a field update precisely because `applyPendingReview` would
  // have dropped this link and regressed the Path.
  it('keeps the retitled row attached to its concept, and the Path ready', async () => {
    expect(await prisma.conceptResource.count({ where: { conceptId, resourceId: ids.plain } })).toBe(1);
    expect(await prisma.path.findUniqueOrThrow({ where: { id: pathId }, select: { status: true } })).toEqual({
      status: PathStatus.spine_ready,
    });
  });

  // PROPERTY 2, measured where it matters: the repaired rows have left the population, so a
  // second `--apply` writes nothing and costs no re-embed.
  it('finds nothing to repair on a second run', async () => {
    const plans = await mine();
    expect([...plans.values()].filter((p) => p.plan.action === 'retitle')).toEqual([]);
    expect(plans.has(PLAIN_URL)).toBe(false);
    expect(plans.has(SECTIONED_URL)).toBe(false);
  });
});
