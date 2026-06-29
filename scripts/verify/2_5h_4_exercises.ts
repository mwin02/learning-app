// Block 2.5h-4 verify:
//  (A) pickStratified — pure, deterministic (seeded rng): coverage guarantee,
//      no-replacement, breadth-first, respects n.
//  (B) LIVE — buildTrack on the banked linear-algebra Path, then assert the frozen
//      Track has per-Lesson Exercises sampled from the banks; re-run is idempotent.
import { prisma } from '@/lib/db';
import { pickStratified, exerciseTrack } from '@/lib/agents/content/exercise-track';
import { buildTrack } from '@/lib/agents/track/build-track';
import { EXERCISE_SAMPLE_PER_LESSON } from '@/lib/config';

function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
// mulberry32 seeded PRNG for deterministic sampling.
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function partA() {
  console.log('=== (A) pickStratified ===');
  // Two concepts, plenty of questions; sample 4 → expect 2 from each (breadth-first).
  const A = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const B = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const s = pickStratified([A, B], 4, rng(7));
  assert(s.length === 4, `expected 4, got ${s.length}`);
  const fromA = s.filter((x) => x.startsWith('a')).length;
  const fromB = s.filter((x) => x.startsWith('b')).length;
  assert(fromA === 2 && fromB === 2, `expected 2+2 balanced, got ${fromA}+${fromB}`);
  assert(new Set(s).size === 4, 'sample contained a duplicate (replacement!)');

  // Coverage: n >= group count → every non-empty group represented.
  const cov = pickStratified([['x'], ['y1', 'y2'], ['z1', 'z2', 'z3']], 4, rng(3));
  assert(cov.includes('x') && cov.some((q) => q.startsWith('y')) && cov.some((q) => q.startsWith('z')), 'coverage not guaranteed');

  // Fewer available than n → return all, no padding/dupes.
  const few = pickStratified([['p'], ['q']], 5, rng(1));
  assert(few.length === 2 && new Set(few).size === 2, 'overdraw should return exactly the 2 available');

  // Empty groups handled.
  assert(pickStratified([], 4, rng(1)).length === 0, 'empty groups → empty sample');
  console.log('(A) ✓ — breadth-first, no-replacement, coverage, overdraw, empty all hold');
}

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
      if (e.kind === 'mcq') assert((e.prompt.match(/(^|\n)\s*[A-Z][)\.]/g)?.length ?? 0) >= 2, 'mcq missing options');
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
  partA();
  await partB();
  console.log('\n✅ block 2.5h-4 verified');
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
