// DB integration test for F1c's severity escalation. It lives here rather than in
// the colocated unit test because the property under test is a PREDICATE — whether
// the `updateMany` where-clause actually selects the row — and the unit test mocks
// Prisma, so it can only assert the clause's shape. A clause that matches nothing
// passes there.
//
// The row that matters is `deprecated` + severity NULL: the column arrived with no
// backfill (20260606000000_resource_deprecation_severity), so every deprecation
// before 2026-06-06 still carries NULL, and those rows still sit in immutable
// Tracks. Nobody ever recorded a liveness verdict on them, so an authoritative 404
// must be able to write one.
//
// Self-cleaning: rows use a __verify_f1c__ marker, deleted in before/after.
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { verifyDeadLink, type LivenessCheck } from '@/lib/curation/verify-dead-link';
import { describeDb } from './db';

const MARK = '__verify_f1c__';

const dead: LivenessCheck = async () => ({ alive: false, reason: 'http 404' });

async function cleanup() {
  await prisma.resourceReport.deleteMany({ where: { user: { email: `${MARK}@example.test` } } });
  await prisma.resource.deleteMany({ where: { topic: MARK } });
  await prisma.source.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { email: `${MARK}@example.test` } });
}

let userId: string;
let sourceId: string;

async function seedResource(slug: string, severity: 'soft' | 'hard' | null): Promise<string> {
  const row = await prisma.resource.create({
    data: {
      topic: MARK,
      slug: `${MARK}${slug}`,
      title: `F1c ${slug}`,
      url: `https://example.com/${MARK}/${slug}`,
      origin: 'agent',
      type: 'article',
      durationMin: 30,
      summary: 'seeded for F1c',
      difficulty: 'beginner',
      status: 'deprecated',
      deprecationSeverity: severity,
      decompositionStatus: 'atomic',
      prerequisiteConcepts: [],
      conceptsTaught: [],
      sourceId,
    },
    select: { id: true },
  });
  return row.id;
}

describeDb('verifyDeadLink — severity escalation', () => {
  beforeAll(async () => {
    await cleanup();
    const user = await prisma.user.create({
      data: { id: `${MARK}user`, email: `${MARK}@example.test` },
      select: { id: true },
    });
    userId = user.id;
    const source = await prisma.source.create({
      data: {
        slug: `${MARK}src`,
        name: 'F1c test source',
        url: 'https://example.com',
        kind: 'community',
      },
      select: { id: true },
    });
    sourceId = source.id;
  });
  afterAll(cleanup);

  // The regression this test exists for. `{ not: 'hard' }` compiles to a plain SQL
  // inequality, which is NULL — not true — for a NULL column, so the escalation
  // silently no-opped on exactly these rows and the report closed `auto_resolved`
  // asserting a verdict nobody made.
  it('escalates a deprecated row with NULL severity to hard', async () => {
    const resourceId = await seedResource('null-severity', null);
    const report = await prisma.resourceReport.create({
      data: { userId, resourceId, category: 'dead_link' },
      select: { id: true },
    });

    const result = await verifyDeadLink({ resourceId, reportId: report.id, check: dead });

    expect(result).toMatchObject({ outcome: 'confirmed_dead', state: 'auto_resolved' });
    const after = await prisma.resource.findUniqueOrThrow({
      where: { id: resourceId },
      select: { status: true, deprecationSeverity: true },
    });
    expect(after).toEqual({ status: 'deprecated', deprecationSeverity: 'hard' });
    const settled = await prisma.resourceReport.findUniqueOrThrow({
      where: { id: report.id },
      select: { state: true, resolution: true },
    });
    expect(settled).toMatchObject({ state: 'auto_resolved', resolution: 'http 404' });
  });

  it('escalates a soft-deprecated row to hard', async () => {
    const resourceId = await seedResource('soft-severity', 'soft');
    const report = await prisma.resourceReport.create({
      data: { userId, resourceId, category: 'dead_link' },
      select: { id: true },
    });

    const result = await verifyDeadLink({ resourceId, reportId: report.id, check: dead });

    expect(result).toMatchObject({ outcome: 'confirmed_dead', state: 'auto_resolved' });
    const after = await prisma.resource.findUniqueOrThrow({
      where: { id: resourceId },
      select: { deprecationSeverity: true },
    });
    expect(after.deprecationSeverity).toBe('hard');
  });

  it('leaves a hard-deprecated row alone and never probes it', async () => {
    const resourceId = await seedResource('hard-severity', 'hard');
    const report = await prisma.resourceReport.create({
      data: { userId, resourceId, category: 'dead_link' },
      select: { id: true },
    });
    let probed = false;
    const check: LivenessCheck = async () => {
      probed = true;
      return { alive: false, reason: 'http 404' };
    };

    const result = await verifyDeadLink({ resourceId, reportId: report.id, check });

    expect(probed).toBe(false);
    expect(result).toMatchObject({ outcome: 'already_deprecated', state: 'auto_resolved' });
  });

  // Pins the Prisma behaviour the fix is built on, so a future refactor back to the
  // terser `{ not: … }` form fails here instead of in production.
  it('confirms Prisma `not` does not match a NULL column', async () => {
    const resourceId = await seedResource('not-probe', null);
    const missed = await prisma.resource.count({
      where: { id: resourceId, deprecationSeverity: { not: 'hard' } },
    });
    const matched = await prisma.resource.count({
      where: {
        id: resourceId,
        OR: [{ deprecationSeverity: 'soft' }, { deprecationSeverity: null }],
      },
    });
    expect(missed).toBe(0);
    expect(matched).toBe(1);
  });
});
