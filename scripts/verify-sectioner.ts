// Verify (LIVE half) for Phase 2.5e (track sections): build a real Track over a
// spine_ready map (which auto-sections best-effort), assert the persisted Section rows
// cover every lesson contiguously, re-run sectionTrack to prove idempotency, then delete
// the Track. Costs one Pro compose + one/two Flash section calls.
//   npx tsx --env-file=.env.local scripts/verify-sectioner.ts <topic>
//
// The PURE half (group-into-sections invariants + repair paths) migrated to
// src/lib/agents/track/group-into-sections.test.ts (R2).

import { TrackStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { sectionTrack } from '../src/lib/agents/track/section-track';
import { buildTrack } from '../src/lib/agents/track/build-track';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

// Assert a section set partitions [orders] into contiguous, in-order, gapless runs.
function assertContiguousPartition(
  label: string,
  orders: number[],
  sections: { orderInTrack: number; lessonOrders: number[] }[],
) {
  const flat = sections.flatMap((s) => s.lessonOrders);
  check(`${label}: covers every lesson exactly once`, JSON.stringify(flat) === JSON.stringify(orders), flat);
  check(
    `${label}: sections numbered 1..k`,
    sections.every((s, i) => s.orderInTrack === i + 1),
    sections.map((s) => s.orderInTrack),
  );
  check(`${label}: no empty section`, sections.every((s) => s.lessonOrders.length > 0));
  check(
    `${label}: each section ascending + contiguous internally`,
    sections.every((s) => s.lessonOrders.every((o, i) => i === 0 || o > s.lessonOrders[i - 1])),
  );
}

async function liveTest(topic: string) {
  console.log(`\nLIVE build + section over '${topic}':`);
  const path = await prisma.path.findFirst({
    where: { topic, status: 'spine_ready' },
    select: { id: true },
  });
  if (!path) {
    console.error(`  ✗ no spine_ready Path for '${topic}'`);
    failures++;
    return;
  }

  const built = await buildTrack({ pathId: path.id, targetMastery: 'beginner' });
  check('build: ready', built.status === TrackStatus.ready, built.status);

  try {
    const lessons = await prisma.lesson.findMany({
      where: { trackId: built.trackId },
      orderBy: { orderInTrack: 'asc' },
      select: { orderInTrack: true, sectionId: true },
    });
    const sections = await prisma.section.findMany({
      where: { trackId: built.trackId },
      orderBy: { orderInTrack: 'asc' },
      select: { id: true, orderInTrack: true, title: true, lessons: { select: { orderInTrack: true }, orderBy: { orderInTrack: 'asc' } } },
    });

    if (lessons.length < 4) {
      check('live: short track left flat', sections.length === 0, sections.length);
    } else if (sections.length === 0) {
      console.log('  (track built but rendered flat — single-chapter or sectioning skipped)');
    } else {
      assertContiguousPartition(
        'live',
        lessons.map((l) => l.orderInTrack),
        sections.map((s) => ({ orderInTrack: s.orderInTrack, lessonOrders: s.lessons.map((l) => l.orderInTrack) })),
      );
      check('live: every lesson has a sectionId', lessons.every((l) => l.sectionId !== null));
      check('live: ≥2 chapters', sections.length >= 2, sections.length);
      console.log('  sections:', sections.map((s) => `${s.orderInTrack}. ${s.title} (${s.lessons.length})`).join(' | '));

      // Idempotency: re-section, assert a clean replacement (no duplicate rows).
      const before = sections.map((s) => s.id).sort();
      await sectionTrack({ trackId: built.trackId });
      const after = await prisma.section.findMany({ where: { trackId: built.trackId }, select: { id: true } });
      check('live: re-section replaced rows (none of the old ids remain)', after.every((s) => !before.includes(s.id)), { before, after: after.map((a) => a.id) });
    }
  } finally {
    await prisma.track.delete({ where: { id: built.trackId } }).catch(() => {});
    console.log('  (cleaned up test Track)');
  }
}

async function main() {
  const topic = process.argv[2];
  if (!topic) {
    console.error('usage: verify-sectioner.ts <topic>   (needs a seeded spine_ready Path)');
    process.exitCode = 1;
    return;
  }
  await liveTest(topic);
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
