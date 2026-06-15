// Throwaway verification for Phase 2.5e-3 (build-track orchestrator). Builds a
// real Track end-to-end over a spine_ready map, asserts the persisted shape, then
// deletes it (cascade) so the dev DB stays clean. Run:
//   npx tsx --env-file=.env.local scripts/verify-build-track.ts              # default machine-learning
//   npx tsx --env-file=.env.local scripts/verify-build-track.ts javascript
//
// Costs one Pro compose call for the successful build.

import { Difficulty, LessonResourceRole, DeliveryMode, TrackStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { buildTrack, TrackBuildError } from '../src/lib/agents/track/build-track';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, detail ?? ''); }
}

async function main() {
  const topic = process.argv[2] ?? 'machine-learning';

  // --- gate: a non-spine_ready Path is rejected before any Track row -------
  console.log('spine_ready gate');
  const building = await prisma.path.findFirst({
    where: { status: { not: 'spine_ready' } },
    select: { id: true, topic: true, status: true },
  });
  if (building) {
    const before = await prisma.track.count({ where: { pathId: building.id } });
    let threw = false;
    try {
      await buildTrack({ pathId: building.id });
    } catch (e) {
      threw = e instanceof TrackBuildError;
    }
    const after = await prisma.track.count({ where: { pathId: building.id } });
    check(`rejects non-spine_ready Path ('${building.topic}' = ${building.status})`, threw);
    check('no Track row created for a rejected build', before === after, { before, after });
  } else {
    console.log('  (no non-spine_ready Path seeded; skipping gate test)');
  }

  // --- full build over a spine_ready map -----------------------------------
  console.log(`build over '${topic}'`);
  const path = await prisma.path.findUnique({ where: { topic }, select: { id: true, status: true } });
  if (!path) { console.error(`no Path for '${topic}'`); process.exit(1); }
  check('target Path is spine_ready', path.status === 'spine_ready', path.status);

  // Defensive: clear any Tracks a previous (crashed) run left on this path. Track
  // is inert/unused outside this builder, so this is safe in the dev DB.
  await prisma.track.deleteMany({ where: { pathId: path.id } });

  const result = await buildTrack({
    pathId: path.id,
    priorKnowledge: 'I know basic programming and high-school algebra.',
    timeframeWeeks: 6,
    hoursPerWeek: 5,
    targetMastery: Difficulty.intermediate,
  });
  console.log('  result:', {
    status: result.status,
    lessons: result.lessonCount,
    budgetWeak: result.budgetWeak,
    underResourced: result.underResourced,
    warnings: result.warnings.length,
  });
  check('returns ready', result.status === TrackStatus.ready);
  check('built ≥1 lesson', result.lessonCount > 0);

  // --- assert the persisted shape ------------------------------------------
  const track = await prisma.track.findUnique({
    where: { id: result.trackId },
    select: {
      status: true, title: true, summary: true, targetMastery: true,
      priorKnowledge: true, timeframeWeeks: true, hoursPerWeek: true,
      lessons: {
        orderBy: { orderInTrack: 'asc' },
        select: {
          orderInTrack: true, title: true, conceptsTaught: true, estMinutes: true,
          resources: { select: { role: true, deliveryMode: true, resourceId: true } },
        },
      },
    },
  });
  if (!track) { console.error('built Track not found'); process.exit(1); }

  check('Track status persisted ready', track.status === TrackStatus.ready);
  check('Track title + summary set', !!track.title && !!track.summary, { title: track.title });
  check('targetMastery stored', track.targetMastery === Difficulty.intermediate);
  check('inputs stored', track.timeframeWeeks === 6 && track.hoursPerWeek === 5 && !!track.priorKnowledge);

  const orders = track.lessons.map((l) => l.orderInTrack);
  check('orderInTrack is dense 1..N', JSON.stringify(orders) === JSON.stringify(orders.map((_, i) => i + 1)), orders);
  check('every lesson teaches ≥1 concept', track.lessons.every((l) => l.conceptsTaught.length >= 1));
  check('every lesson has estMinutes > 0', track.lessons.every((l) => l.estMinutes > 0));

  let shapeOk = true;
  for (const l of track.lessons) {
    const primaries = l.resources.filter((r) => r.role === LessonResourceRole.primary);
    const alternates = l.resources.filter((r) => r.role === LessonResourceRole.alternate);
    const allNewtab = l.resources.every((r) => r.deliveryMode === DeliveryMode.newtab);
    const primaryNotAlt = primaries.length === 1 && !alternates.some((a) => a.resourceId === primaries[0].resourceId);
    if (primaries.length !== 1 || !allNewtab || !primaryNotAlt) {
      shapeOk = false;
      console.error('    bad lesson:', l.orderInTrack, { primaries: primaries.length, alternates: alternates.length });
    }
  }
  check('each lesson: exactly 1 primary, all newtab, primary ∉ alternates', shapeOk);

  // --- cleanup (cascade deletes lessons + lessonResources) -----------------
  await prisma.track.delete({ where: { id: result.trackId } });
  const gone = await prisma.track.findUnique({ where: { id: result.trackId }, select: { id: true } });
  const orphanLessons = await prisma.lesson.count({ where: { trackId: result.trackId } });
  check('cleanup: Track deleted', gone === null);
  check('cleanup: no orphan lessons (cascade)', orphanLessons === 0);

  await prisma.$disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
