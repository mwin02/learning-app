// Track-build cleanup pass — deterministic, runs after allocate (2.5e-7a) and
// before persist. Two post-processing steps the allocator deliberately leaves to
// a separate pass so the arithmetic stays clean:
//
//   1. CROSS-LESSON DEDUP. One Resource can be a candidate of several Concepts
//      (legitimate at the Path level — a broad "derivative rules review" genuinely
//      serves both `the-derivative` and `rules-of-differentiation`). But within a
//      single learner's Track the same resource showing up as the primary (or an
//      alternate) of two lessons is just a visible duplicate. We keep the resource
//      in the FIRST lesson that uses it and strip it from later ones. If stripping
//      empties a lesson's primaries, we promote its best unused alternate
//      (preferring a `teaches`), so the lesson keeps a real primary. Last resort —
//      a resource that is the only primary for two lessons with no replacement —
//      keeps the duplicate and records a warning rather than yield a 0-primary
//      lesson.
//
//   2. ALTERNATE CAP. Cap each lesson's optional-pool alternates to the number of
//      primaries, but ALWAYS keep the demoted mandatory-core tail (those were
//      intended core, more valuable than pool fillers). So:
//        alternates = [surviving demoted-core] ++ [surviving pool].slice(0, #primaries)
//
// Pure: no IO, no Prisma, no LLM — fixture-testable. The builder maps allocate's
// output into this contract and persists the result.

import { ConceptResourceRole } from '@prisma/client';
import type { AllocatedLesson, AllocatorCandidate } from '@/lib/agents/track/allocate';

export type CleanupLesson = Pick<
  AllocatedLesson,
  'key' | 'primaries' | 'alternates' | 'demotedCoreCount'
>;

export type CleanedLesson = {
  key: string;
  primaries: AllocatorCandidate[];
  alternates: AllocatorCandidate[];
  // Sum of the final primaries' durations (recomputed — dedup can swap a primary).
  estMinutes: number;
};

export type CleanupResult = {
  lessons: CleanedLesson[];
  warnings: string[];
};

export function cleanupLessons(args: {
  // Lessons in final track order (allocate's `kept`).
  lessons: CleanupLesson[];
  // resourceId → its ConceptResource role, so promotion can prefer a `teaches`.
  roleById: ReadonlyMap<string, ConceptResourceRole>;
}): CleanupResult {
  const { lessons, roleById } = args;
  const used = new Set<string>();
  const warnings: string[] = [];
  const out: CleanedLesson[] = [];

  for (const l of lessons) {
    const demoted = l.alternates.slice(0, l.demotedCoreCount);
    const pool = l.alternates.slice(l.demotedCoreCount);

    // 1a. Drop primaries already used by an earlier lesson.
    let primaries = l.primaries.filter((p) => !used.has(p.resourceId));

    // 1b. If dedup emptied the core, promote the best unused alternate — a
    // `teaches` first (so the lesson keeps a real teacher), demoted-core before
    // pool. Last resort: keep the original first primary even though it duplicates.
    if (primaries.length === 0) {
      const replacement = pickReplacement([...demoted, ...pool], used, roleById);
      if (replacement) {
        primaries = [replacement];
      } else {
        primaries = l.primaries.slice(0, 1);
        warnings.push(`lesson ${l.key}: only primary duplicates an earlier lesson and has no replacement; kept the duplicate`);
      }
    }
    const primaryIds = new Set(primaries.map((p) => p.resourceId));

    // 2. Dedup alternates (drop used or just-promoted), then cap the pool to
    // #primaries while keeping all surviving demoted-core.
    const keepDemoted = demoted.filter((a) => !used.has(a.resourceId) && !primaryIds.has(a.resourceId));
    const keepPool = pool
      .filter((a) => !used.has(a.resourceId) && !primaryIds.has(a.resourceId))
      .slice(0, primaries.length);
    const alternates = [...keepDemoted, ...keepPool];

    for (const p of primaries) used.add(p.resourceId);
    for (const a of alternates) used.add(a.resourceId);

    out.push({
      key: l.key,
      primaries,
      alternates,
      estMinutes: primaries.reduce((s, p) => s + p.durationMin, 0),
    });
  }

  return { lessons: out, warnings };
}

// First unused candidate, preferring a `teaches` role over `uses`/`assesses`.
function pickReplacement(
  candidates: AllocatorCandidate[],
  used: ReadonlySet<string>,
  roleById: ReadonlyMap<string, ConceptResourceRole>,
): AllocatorCandidate | undefined {
  const free = candidates.filter((c) => !used.has(c.resourceId));
  return (
    free.find((c) => roleById.get(c.resourceId) === ConceptResourceRole.teaches) ?? free[0]
  );
}
