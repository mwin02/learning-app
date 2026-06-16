// Throwaway verification for Phase 2.5e (track sections). Two layers:
//
//   1. PURE (free, always runs): exercises group-into-sections.ts — the
//      contiguity-by-construction invariant + every repair path. No LLM, no DB.
//   2. LIVE (opt-in, pass a topic): builds a real Track over a spine_ready map
//      (which now auto-sections best-effort), asserts the persisted Section rows
//      cover every lesson contiguously, re-runs sectionTrack to prove idempotency,
//      then deletes the Track. Costs one Pro compose + one/two Flash section calls.
//
//   npx tsx --env-file=.env.local scripts/verify-sectioner.ts                # pure only
//   npx tsx --env-file=.env.local scripts/verify-sectioner.ts javascript     # + live build

import { TrackStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { groupIntoSections } from '../src/lib/agents/track/group-into-sections';
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

function pureTests() {
  console.log('PURE group-into-sections:');
  const orders = [1, 2, 3, 4, 5, 6];

  // Happy path: three clean chapters.
  {
    const r = groupIntoSections({
      lessonOrders: orders,
      boundaries: [
        { startsAtLesson: 1, title: 'A', intro: 'a' },
        { startsAtLesson: 3, title: 'B', intro: 'b' },
        { startsAtLesson: 5, title: 'C', intro: 'c' },
      ],
      fallbackTitle: 'T',
    });
    assertContiguousPartition('happy', orders, r.sections);
    check('happy: 3 sections', r.sections.length === 3);
    check('happy: boundaries respected', JSON.stringify(r.sections[1].lessonOrders) === JSON.stringify([3, 4]));
  }

  // Model didn't start at lesson 1 → clamp, no orphan lead-in.
  {
    const r = groupIntoSections({
      lessonOrders: orders,
      boundaries: [
        { startsAtLesson: 3, title: 'B', intro: 'b' },
        { startsAtLesson: 5, title: 'C', intro: 'c' },
      ],
      fallbackTitle: 'T',
    });
    assertContiguousPartition('clamp', orders, r.sections);
    check('clamp: first section absorbs lead-in 1,2', JSON.stringify(r.sections[0].lessonOrders) === JSON.stringify([1, 2, 3, 4]));
  }

  // Out-of-range + duplicate + unsorted boundaries are repaired.
  {
    const r = groupIntoSections({
      lessonOrders: orders,
      boundaries: [
        { startsAtLesson: 4, title: 'B', intro: 'b' },
        { startsAtLesson: 99, title: 'X', intro: 'x' },
        { startsAtLesson: 1, title: 'A', intro: 'a' },
        { startsAtLesson: 4, title: 'Bdup', intro: 'b2' },
      ],
      fallbackTitle: 'T',
    });
    assertContiguousPartition('repair', orders, r.sections);
    check('repair: 2 sections (dup + oob dropped)', r.sections.length === 2, r.sections.length);
    check('repair: warned', r.warnings.length >= 2, r.warnings);
  }

  // No usable boundaries → single fallback chapter.
  {
    const r = groupIntoSections({ lessonOrders: orders, boundaries: [], fallbackTitle: 'Whole Course' });
    check('empty: single chapter', r.sections.length === 1 && r.sections[0].title === 'Whole Course');
    assertContiguousPartition('empty', orders, r.sections);
  }
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
  pureTests();
  const topic = process.argv[2];
  if (topic) await liveTest(topic);
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
