// Lesson View v3: the derivation behind the core-resource rail. A lesson can
// carry several mandatory complementary resources (LessonResource.role=primary,
// ordered by orderInLesson) plus an optional substitute pool (role=alternate).
// The v3 sheet works one core at a time on a stage, with the rail tracking the
// rest — so the split, the numbering, and every label the rail prints are
// derived here rather than inside the client component.

import type { TrackResourceView } from '@/lib/track-view';

// How a resource reaches the learner. Distinct from LessonResource.deliveryMode
// because a generated row (`content != null`) has no external page at all — it
// renders inline as a handout regardless of the mode stored on the join.
export type ResourceDelivery = 'embed' | 'handout' | 'newtab';

export type ResourceRailRow = {
  // LessonResource id — the stage and the rail address a resource by this.
  id: string;
  // 1-based position among the cores; the rail prints it in the badge.
  n: number;
  title: string;
  delivery: ResourceDelivery;
  // "embed · ~12 min" — the delivery label, plus a duration when the library
  // actually measured one.
  meta: string;
};

export type LessonResourcesView = {
  cores: TrackResourceView[];
  alternates: TrackResourceView[];
  rail: ResourceRailRow[];
  // "3 extras" — null when the lesson has no alternates.
  optionalSummary: string | null;
};

export function deliveryOf(r: TrackResourceView): ResourceDelivery {
  if (r.resource.content != null) return 'handout';
  return r.deliveryMode === 'embed' ? 'embed' : 'newtab';
}

const DELIVERY_LABEL: Record<ResourceDelivery, string> = {
  embed: 'embed',
  handout: 'handout',
  newtab: 'opens new tab',
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function railMeta(r: TrackResourceView): string {
  const parts = [DELIVERY_LABEL[deliveryOf(r)]];
  const mins = r.resource.durationMin;
  if (mins != null && mins > 0) parts.push(`~${mins} min`);
  return parts.join(' · ');
}

// Just the count. A per-delivery breakdown ("1 embed, 2 links") was a
// distinction without a difference here: every extra opens away from the sheet.
function optionalSummary(alternates: TrackResourceView[]): string | null {
  return alternates.length === 0 ? null : plural(alternates.length, 'extra');
}

export function buildLessonResourcesView(resources: TrackResourceView[]): LessonResourcesView {
  let cores = resources.filter((r) => r.role === 'primary');
  let alternates = resources.filter((r) => r.role !== 'primary');
  // Defensive: a lesson with no primary row would otherwise render an empty
  // stage. Promote the first resource so something plays.
  if (cores.length === 0 && resources.length > 0) {
    cores = [resources[0]];
    alternates = resources.slice(1);
  }

  return {
    cores,
    alternates,
    rail: cores.map((r, i) => ({
      id: r.id,
      n: i + 1,
      title: r.resource.title,
      delivery: deliveryOf(r),
      meta: railMeta(r),
    })),
    optionalSummary: optionalSummary(alternates),
  };
}

// The line under the lesson title: "~35 min · 3 core resources · 5 questions".
// Zero-count clauses are dropped rather than printed as "0 questions".
export function lessonMetaLine({
  estMinutes,
  coreCount,
  exerciseCount,
}: {
  estMinutes: number;
  coreCount: number;
  exerciseCount: number;
}): string {
  const parts = [`~${estMinutes} min`];
  if (coreCount > 0) parts.push(plural(coreCount, 'core resource'));
  if (exerciseCount > 0) parts.push(plural(exerciseCount, 'question'));
  return parts.join(' · ');
}

// "1 of 3 done · work through all 3". The mock's second clause read "all three
// required", which contradicts the footer's "nothing is gated" — nothing
// enforces the cores, so the copy encourages rather than claims a rule. It only
// makes sense for a genuinely multi-core lesson, so it's dropped for one core.
export function coreProgressLine(doneCount: number, total: number): string {
  const head = `${doneCount} of ${total} done`;
  return total > 1 ? `${head} · work through all ${total}` : head;
}
