// DB integration test for the Pre-Freeze Map Review DB edges (Block 2): the
// read-only loadAssembledMap and the idempotent writePathReview. The LLM critic
// (reviewMap) is NOT exercised here — per CLAUDE.md, LLM-cost paths stay in the
// manual scripts/review-map.ts driver, not Vitest. This covers exactly the
// deterministic, DB-touching halves.
//
// Self-cleaning: all rows use a __verify_pathreview__ marker, deleted in
// before/afterAll. Skips cleanly when DATABASE_URL is unset (describeDb).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { ConceptMembership, ConceptResourceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { loadAssembledMap, writePathReview } from '@/lib/agents/map/path-review';
import type { MapReviewFinding } from '@/lib/agents/map/review-map';
import { describeDb } from './db';

const MARK = '__verify_pathreview__';
const TOPIC = `${MARK}-topic`;

async function cleanup() {
  // PathReview / Concept / ConceptPrereq / ConceptResource cascade from Path; the
  // Resource + Source are standalone, deleted by marker.
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
}

// Seed a tiny Path: two spine concepts (one healthy teaches, one relaxed with a
// sub-floor uses) + one prereq edge + a shared Resource.
async function seed(): Promise<string> {
  const source = await prisma.source.create({
    data: { slug: `${MARK}-src`, name: 'verify src', url: 'https://example.invalid', kind: 'community' },
  });
  const resource = await prisma.resource.create({
    data: {
      slug: `${MARK}-res`, topic: TOPIC, title: 'Verify Resource', url: 'https://example.invalid/r',
      type: 'article', durationMin: 30, summary: 's', difficulty: 'beginner', sourceId: source.id,
    },
  });
  const path = await prisma.path.create({ data: { topic: TOPIC, status: 'spine_ready' } });
  const alpha = await prisma.concept.create({
    data: { pathId: path.id, slug: 'alpha', title: 'Alpha', membership: ConceptMembership.spine },
  });
  const beta = await prisma.concept.create({
    data: { pathId: path.id, slug: 'beta', title: 'Beta', membership: ConceptMembership.spine, primaryRelaxed: true },
  });
  await prisma.conceptPrereq.create({
    data: { pathId: path.id, fromConceptId: alpha.id, toConceptId: beta.id },
  });
  // alpha: a healthy teaches (0.9). beta: only a sub-floor uses (0.4) — relaxed.
  await prisma.conceptResource.createMany({
    data: [
      { conceptId: alpha.id, resourceId: resource.id, role: ConceptResourceRole.teaches, coverageScore: 0.9 },
      { conceptId: beta.id, resourceId: resource.id, role: ConceptResourceRole.uses, coverageScore: 0.4 },
    ],
  });
  return path.id;
}

describeDb('loadAssembledMap + writePathReview', () => {
  let pathId: string;

  beforeAll(async () => {
    await cleanup();
    pathId = await seed();
  });
  afterAll(cleanup);

  it('loads concepts with their chosen primary and the edges', async () => {
    const map = await loadAssembledMap(pathId);
    expect(map.topic).toBe(TOPIC);
    expect(map.edges).toEqual([{ fromSlug: 'alpha', toSlug: 'beta' }]);

    const byslug = new Map(map.concepts.map((c) => [c.slug, c]));
    expect(byslug.get('alpha')?.primary).toEqual({ title: 'Verify Resource', role: 'teaches', coverageScore: 0.9 });
    expect(byslug.get('alpha')?.primaryRelaxed).toBe(false);
    // beta has no teaches, so its chosen primary falls back to the best candidate.
    expect(byslug.get('beta')?.primary).toEqual({ title: 'Verify Resource', role: 'uses', coverageScore: 0.4 });
    expect(byslug.get('beta')?.primaryRelaxed).toBe(true);
  });

  it('writes findings, then replaces the OPEN set on a re-run (idempotent backfill)', async () => {
    const first: MapReviewFinding[] = [
      { kind: 'hollow', conceptSlugs: ['beta'], message: 'first' },
      { kind: 'duplication', conceptSlugs: ['alpha', 'beta'], message: 'first-dup' },
    ];
    expect((await writePathReview(pathId, first)).written).toBe(2);
    expect(await prisma.pathReview.count({ where: { pathId } })).toBe(2);

    // Re-run with a different finding set — the two open rows are replaced, not added.
    const second: MapReviewFinding[] = [{ kind: 'hollow', conceptSlugs: ['beta'], message: 'second' }];
    expect((await writePathReview(pathId, second)).written).toBe(1);
    const rows = await prisma.pathReview.findMany({ where: { pathId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('second');
  });

  it('preserves a RESOLVED row across a re-run and can write to empty', async () => {
    // Mark the current open row resolved (as Block 3's apply would).
    await prisma.pathReview.updateMany({ where: { pathId }, data: { resolved: true, resolution: 'dismissed' } });

    // A re-review that finds nothing must not touch the resolved row.
    expect((await writePathReview(pathId, [])).written).toBe(0);
    const rows = await prisma.pathReview.findMany({ where: { pathId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].resolved).toBe(true);
    expect(rows[0].resolution).toBe('dismissed');
  });
});
