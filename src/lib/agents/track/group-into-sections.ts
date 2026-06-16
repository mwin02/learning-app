// Phase 2.5e (track sections): the deterministic half of the sectioner — turns the
// model's chapter BOUNDARIES (sectioner.ts) into concrete chapters over a Track's
// ordered lessons. No LLM, no IO; pure + fixture-testable, mirroring how
// validate-composition.ts is the pure critic of composer.ts.
//
// The contiguity invariant is enforced BY CONSTRUCTION here: lessons arrive already
// ordered (by orderInTrack); each is assigned to the latest boundary whose
// `startsAtLesson` ≤ its order, which can only ever produce contiguous runs. So
// however the model answers — out-of-range starts, a missing first boundary,
// duplicate starts, unsorted — the output is always a valid set of contiguous,
// non-overlapping chapters that together cover every lesson exactly once.
//
// Repairs (all silent + deterministic, surfaced via `warnings`):
//   - boundaries are sorted by start and de-duplicated (first title/intro wins);
//   - out-of-range starts (no such lesson order) are dropped;
//   - the first chapter is clamped to the first lesson, so any lessons before the
//     model's earliest boundary still get a home (no orphan lead-in);
//   - if nothing usable survives, the whole Track is one chapter (caller decides
//     whether a single chapter is worth persisting).

import type { SectionBoundary } from '@/lib/agents/track/sectioner';

// One materialized chapter: its 1-based position, framing, and the lessons in it
// (in order). `lessonOrders` are the orderInTrack values the caller maps to ids.
export type GroupedSection = {
  orderInTrack: number;
  title: string;
  intro: string;
  lessonOrders: number[];
};

export type GroupResult = {
  sections: GroupedSection[];
  warnings: string[];
};

export function groupIntoSections(args: {
  // Lesson orderInTrack values, ascending (as persisted). Must be non-empty.
  lessonOrders: number[];
  boundaries: SectionBoundary[];
  // Fallback chapter title when the model gave nothing usable (caller passes the
  // track title). Only used for the degenerate single-chapter repair.
  fallbackTitle: string;
}): GroupResult {
  const warnings: string[] = [];
  const orders = [...args.lessonOrders].sort((a, b) => a - b);
  if (orders.length === 0) return { sections: [], warnings };
  const validOrders = new Set(orders);

  // Sort by start; drop out-of-range; keep the first boundary at each start.
  const seenStart = new Set<number>();
  const cleaned: SectionBoundary[] = [];
  for (const b of [...args.boundaries].sort((a, z) => a.startsAtLesson - z.startsAtLesson)) {
    if (!validOrders.has(b.startsAtLesson)) {
      warnings.push(`dropped boundary at non-existent lesson ${b.startsAtLesson}`);
      continue;
    }
    if (seenStart.has(b.startsAtLesson)) {
      warnings.push(`dropped duplicate boundary at lesson ${b.startsAtLesson}`);
      continue;
    }
    seenStart.add(b.startsAtLesson);
    cleaned.push(b);
  }

  // Degenerate: nothing usable → one chapter spanning the whole Track.
  if (cleaned.length === 0) {
    warnings.push('no usable boundaries; placed all lessons in a single chapter');
    return {
      sections: [{ orderInTrack: 1, title: args.fallbackTitle, intro: '', lessonOrders: orders }],
      warnings,
    };
  }

  // Clamp the first chapter to the first lesson so no lead-in lesson is orphaned.
  if (cleaned[0].startsAtLesson !== orders[0]) {
    warnings.push(
      `first boundary started at lesson ${cleaned[0].startsAtLesson}; clamped to ${orders[0]}`,
    );
    cleaned[0] = { ...cleaned[0], startsAtLesson: orders[0] };
  }

  // Assign each lesson to the latest boundary whose start ≤ its order. Both lists
  // are sorted, so a single forward walk yields contiguous runs by construction.
  const sections: GroupedSection[] = cleaned.map((b) => ({
    orderInTrack: 0, // numbered after empty chapters are dropped
    title: b.title,
    intro: b.intro,
    lessonOrders: [] as number[],
  }));
  let bi = 0;
  for (const order of orders) {
    while (bi + 1 < cleaned.length && cleaned[bi + 1].startsAtLesson <= order) bi++;
    sections[bi].lessonOrders.push(order);
  }

  // Drop any empty chapter (possible if two boundaries shared a run after clamping)
  // and number the survivors 1..k.
  const nonEmpty = sections.filter((s) => s.lessonOrders.length > 0);
  nonEmpty.forEach((s, i) => (s.orderInTrack = i + 1));
  return { sections: nonEmpty, warnings };
}
