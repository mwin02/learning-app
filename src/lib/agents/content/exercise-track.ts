// Phase 2.5h-4: the build-time selection pass — snapshots a Track's per-Lesson
// exercises by SAMPLING from the concept question banks (2.5h-3), no LLM call.
//
// Runs AFTER buildTrack freezes the Track (mirrors section-track.ts): a best-effort,
// non-fatal, standalone + idempotent pass over the frozen lessons. The expensive
// authoring already happened once per concept at spine-readiness; here we just pick
// a stratified random sample per lesson and freeze it into Exercise rows, so two
// Tracks off the same Path get independently-sampled exercises from one bank.
//
// Selection per lesson: gather the question banks of the lesson's concept(s)
// (conceptsTaught is usually one slug, occasionally a few merged concepts), take a
// STRATIFIED sample — round-robin across the concepts so each contributes before any
// repeats — filled at random up to EXERCISE_SAMPLE_PER_LESSON. A lesson whose
// concepts have no bank yet gets no exercises (non-fatal); the Origin of each
// snapshot is carried from the source ConceptQuestion.
//
// Idempotent: it deletes this Track's existing Exercises and re-selects, so a re-run
// (or a backfill of an old Track) cleanly replaces them. One transaction so a
// half-applied re-selection never ships.

import { Origin, ExerciseKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { EXERCISE_SAMPLE_PER_LESSON } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type ExerciseTrackResult = {
  // Lessons that received ≥1 exercise.
  lessonsWithExercises: number;
  // Lessons skipped because their concept(s) had no bank questions.
  lessonsSkipped: number;
  // Total Exercise rows written.
  exercises: number;
  warnings: string[];
};

type BankQuestion = {
  prompt: string;
  answer: string;
  rubric: string;
  kind: ExerciseKind;
  origin: Origin;
};

// Stratified sample WITHOUT replacement: round-robin across the groups (each a
// concept's questions) so every concept contributes one before any contributes a
// second, filling up to `n`. Within a group the order is randomized by `rng`, so a
// re-run draws a different sample. Pure + injectable rng → deterministically
// testable. Guarantees ≥1 per non-empty group as long as n ≥ the group count.
export function pickStratified<T>(groups: T[][], n: number, rng: () => number = Math.random): T[] {
  // Shuffle a shallow copy of each group (Fisher–Yates) so we never mutate input.
  const pools = groups.map((g) => {
    const a = g.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  });

  const out: T[] = [];
  let exhausted = false;
  while (out.length < n && !exhausted) {
    exhausted = true;
    for (const pool of pools) {
      if (out.length >= n) break;
      const next = pool.shift();
      if (next !== undefined) {
        out.push(next);
        exhausted = false;
      }
    }
  }
  return out;
}

export async function exerciseTrack(args: {
  trackId: string;
  samplePerLesson?: number;
  onTrace?: OnTrace;
}): Promise<ExerciseTrackResult> {
  const { trackId, samplePerLesson = EXERCISE_SAMPLE_PER_LESSON, onTrace = () => {} } = args;

  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: {
      id: true,
      pathId: true,
      lessons: {
        orderBy: { orderInTrack: 'asc' },
        select: { id: true, conceptsTaught: true },
      },
    },
  });
  if (!track) throw new Error(`exerciseTrack: no Track '${trackId}'.`);

  // Pull every bank question for the Path's concepts once, indexed by concept slug
  // (lessons reference concepts by slug via conceptsTaught).
  const concepts = await prisma.concept.findMany({
    where: { pathId: track.pathId },
    select: {
      slug: true,
      questions: { select: { prompt: true, answer: true, rubric: true, kind: true, origin: true } },
    },
  });
  const bankBySlug = new Map<string, BankQuestion[]>(concepts.map((c) => [c.slug, c.questions]));

  const warnings: string[] = [];
  const result: ExerciseTrackResult = { lessonsWithExercises: 0, lessonsSkipped: 0, exercises: 0, warnings };

  onTrace({
    kind: 'stage',
    label: 'exercise selection started',
    detail: { trackId, lessons: track.lessons.length, samplePerLesson },
  });

  // Build the per-lesson selections in memory, then apply in one transaction.
  const perLesson = track.lessons.map((lesson) => {
    const groups = lesson.conceptsTaught
      .map((slug) => bankBySlug.get(slug) ?? [])
      .filter((g) => g.length > 0);
    const picked = groups.length ? pickStratified(groups, samplePerLesson) : [];
    return { lessonId: lesson.id, picked };
  });

  await prisma.$transaction(async (tx) => {
    // Idempotent: clear this Track's existing exercises (scoped to its lessons).
    await tx.exercise.deleteMany({ where: { lesson: { trackId } } });
    for (const { lessonId, picked } of perLesson) {
      if (picked.length === 0) continue;
      await tx.exercise.createMany({
        data: picked.map((q) => ({
          lessonId,
          prompt: q.prompt,
          answer: q.answer,
          rubric: q.rubric,
          kind: q.kind,
          origin: q.origin,
        })),
      });
    }
  });

  for (const { picked } of perLesson) {
    if (picked.length > 0) {
      result.lessonsWithExercises++;
      result.exercises += picked.length;
    } else {
      result.lessonsSkipped++;
    }
  }

  if (result.lessonsSkipped > 0) {
    warnings.push(`${result.lessonsSkipped} lesson(s) had no bank questions; left without exercises`);
  }

  onTrace({ kind: 'stage', label: 'exercise selection done', detail: { trackId, ...result, warnings: warnings.length } });
  console.log('[content-exercise-track] selected', { trackId, ...result });

  return result;
}
