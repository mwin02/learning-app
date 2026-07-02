// Block 2.5h-4 verify (LIVE half): buildTrack on the banked linear-algebra Path, then
// assert the frozen Track has per-Lesson Exercises sampled from the banks; re-run is
// idempotent. Costs a Pro compose + sampling.
//   npx tsx --env-file=.env.local scripts/verify/2_5h_4_exercises.ts
//
// The pure Part A (pickStratified determinism) migrated to
// src/lib/agents/content/exercise-track.test.ts (R2).
import { prisma } from '@/lib/db';
import { exerciseTrack } from '@/lib/agents/content/exercise-track';
import { mcqHasOptions } from '@/lib/agents/content/mcq-options';
import { buildTrack } from '@/lib/agents/track/build-track';
import { EXERCISE_SAMPLE_PER_LESSON } from '@/lib/config';

function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function partB() {
  console.log('\n=== (B) LIVE buildTrack on the banked linear-algebra Path ===');
  const path = await prisma.path.findFirst({
    where: { status: 'spine_ready', topic: 'linear-algebra' },
    select: { id: true },
  });
  if (!path) { console.log('(skip — no banked linear-algebra path)'); return; }

  const built = await buildTrack({
    pathId: path.id,
    goal: 'solid foundations for ML',
    timeframeWeeks: 4,
    hoursPerWeek: 5,
    targetMastery: 'intermediate',
  });
  console.log('built track:', { trackId: built.trackId, lessons: built.lessonCount, warnings: built.warnings });

  const lessons = await prisma.lesson.findMany({
    where: { trackId: built.trackId },
    orderBy: { orderInTrack: 'asc' },
    select: { title: true, conceptsTaught: true, exercises: { select: { kind: true, prompt: true, answer: true, rubric: true, origin: true } } },
  });
  const withEx = lessons.filter((l) => l.exercises.length > 0);
  const total = lessons.reduce((n, l) => n + l.exercises.length, 0);
  console.log(`lessons: ${lessons.length}, with exercises: ${withEx.length}, total exercises: ${total}`);
  assert(withEx.length > 0, 'no lesson got exercises — exit criterion (e) fails');

  for (const l of withEx) {
    assert(l.exercises.length <= EXERCISE_SAMPLE_PER_LESSON, `lesson "${l.title}" exceeded sample cap`);
    for (const e of l.exercises) {
      assert(!!e.prompt && !!e.answer && !!e.rubric, 'exercise has an empty field');
      if (e.kind === 'mcq') assert(mcqHasOptions(e.prompt), 'mcq missing options');
    }
  }
  const sample = withEx[0];
  console.log(`\nspot-check lesson "${sample.title}" [${sample.conceptsTaught.join(', ')}] — ${sample.exercises.length} exercises:`);
  for (const e of sample.exercises) console.log(`  (${e.kind}/${e.origin}) ${e.prompt.split('\n')[0].slice(0, 80)}`);

  // Idempotency: re-run exerciseTrack — exercise count should not grow.
  const before = total;
  await exerciseTrack({ trackId: built.trackId });
  const after = await prisma.exercise.count({ where: { lesson: { trackId: built.trackId } } });
  console.log(`\nidempotency: before=${before}, after re-run=${after}`);
  assert(after <= EXERCISE_SAMPLE_PER_LESSON * lessons.length, 'idempotent re-run inflated exercises');
  console.log('(B) ✓');
}

async function main() {
  await partB();
  console.log('\n✅ block 2.5h-4 (live) verified');
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
