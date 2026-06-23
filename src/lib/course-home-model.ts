// Phase 2.6 (learn UI): the view-model for the course home/summary page. A pure
// derivation from the Track read projection + the learner's completed-lesson set
// (localStorage, anonymous) into everything the home page renders — section/lesson
// statuses, fractions, progress bars, the "continue" lesson, time remaining, and
// the per-lesson type icon kind. Keeping it pure means the components stay dumb and
// this is unit-checkable without a DOM.
//
// Notes on our data vs. the source design:
//  - No lesson gating exists, so there is no "locked" status — lessons are
//    done | current | todo only (the first not-done lesson is "current").
//  - No learning-outcomes field — "What you'll learn" renders distinct
//    conceptsTaught as "Key concepts" chips instead.
//  - No time tracking — the "Time spent" stat is replaced by "Lessons completed".

import type { TrackView, TrackLessonView } from '@/lib/track-view';
import { formatDuration } from '@/lib/format-duration';

export type LessonStatus = 'done' | 'current' | 'todo';
export type LessonTypeKind = 'video' | 'embed' | 'link';
export type SectionStatus = 'done' | 'active' | 'not_started';

export type CourseHomeLesson = {
  id: string;
  orderInTrack: number;
  title: string;
  meta: string;
  status: LessonStatus;
  type: LessonTypeKind;
};

export type CourseHomeSection = {
  id: string;
  n: number;
  title: string;
  lessons: CourseHomeLesson[];
  total: number;
  doneCount: number;
  fraction: string;
  countLabel: string;
  durLabel: string;
  status: SectionStatus;
  barPct: number;
};

export type ContinueLesson = {
  id: string;
  title: string;
  meta: string;
  type: LessonTypeKind;
};

export type CourseHomeModel = {
  trackId: string;
  topic: string;
  title: string;
  summary: string | null;
  eyebrow: string;
  level: string;
  totalLessons: number;
  doneCount: number;
  progressPct: number;
  timeRemainingLabel: string;
  totalTimeLabel: string;
  sectionCount: number;
  sections: CourseHomeSection[];
  continueLesson: ContinueLesson | null;
  keyConcepts: string[];
};

// The lesson's representative type comes from its primary resource (the resources
// arrive in allocator order, primary first). `interactive` / embed delivery → embed
// icon; `video` → video; everything else (article/docs/book/course) → reading link.
function lessonTypeOf(lesson: TrackLessonView): LessonTypeKind {
  const primary = lesson.resources[0];
  if (!primary) return 'link';
  if (primary.deliveryMode === 'embed') return 'embed';
  switch (primary.resource.type) {
    case 'video':
      return 'video';
    case 'interactive':
      return 'embed';
    default:
      return 'link';
  }
}

// "vector-addition" → "Vector addition". conceptsTaught are stable per-Path slugs.
function humanizeConcept(slug: string): string {
  const spaced = slug.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MAX_KEY_CONCEPTS = 12;

export function buildCourseHomeModel(track: TrackView, completed: Set<string>): CourseHomeModel {
  const lessonsInOrder = track.lessons;
  const totalLessons = lessonsInOrder.length;
  const doneCount = lessonsInOrder.filter((l) => completed.has(l.id)).length;

  // The "current" lesson is the first not-done lesson in track order; everything
  // after it that isn't done is "todo". Null when the whole course is complete.
  const currentLesson = lessonsInOrder.find((l) => !completed.has(l.id)) ?? null;

  const statusOf = (lessonId: string): LessonStatus => {
    if (completed.has(lessonId)) return 'done';
    if (currentLesson && lessonId === currentLesson.id) return 'current';
    return 'todo';
  };

  // Group lessons under their sections; synthesize a single "Course content"
  // pseudo-section when the best-effort sectioner produced a flat track.
  const sectionDefs =
    track.sections.length > 0
      ? track.sections
      : [{ id: '__all__', orderInTrack: 1, title: 'Course content', intro: null }];

  const sections: CourseHomeSection[] = sectionDefs.map((section, i) => {
    const lessons =
      section.id === '__all__'
        ? lessonsInOrder
        : lessonsInOrder.filter((l) => l.sectionId === section.id);
    const total = lessons.length;
    const sectionDone = lessons.filter((l) => completed.has(l.id)).length;
    const sectionMinutes = lessons.reduce((sum, l) => sum + l.estMinutes, 0);
    const containsCurrent = !!currentLesson && lessons.some((l) => l.id === currentLesson.id);

    let status: SectionStatus;
    if (total > 0 && sectionDone === total) status = 'done';
    else if (sectionDone > 0 || containsCurrent) status = 'active';
    else status = 'not_started';

    return {
      id: section.id,
      n: i + 1,
      title: section.title,
      total,
      doneCount: sectionDone,
      fraction: `${sectionDone}/${total}`,
      countLabel: `${total} lesson${total === 1 ? '' : 's'}`,
      durLabel: `~${formatDuration(sectionMinutes)}`,
      status,
      barPct: total > 0 ? Math.round((sectionDone / total) * 100) : 0,
      lessons: lessons.map((l) => ({
        id: l.id,
        orderInTrack: l.orderInTrack,
        title: l.title,
        meta: `${l.estMinutes} min`,
        status: statusOf(l.id),
        type: lessonTypeOf(l),
      })),
    };
  });

  // "Continue learning" target = the current lesson, annotated with its section.
  let continueLesson: ContinueLesson | null = null;
  if (currentLesson) {
    const owning = sections.find((s) => s.lessons.some((l) => l.id === currentLesson.id));
    const typeLabel = lessonTypeOf(currentLesson);
    const sectionPart = owning ? `Section ${owning.n} · ` : '';
    continueLesson = {
      id: currentLesson.id,
      title: currentLesson.title,
      meta: `${sectionPart}${continueTypeLabel(typeLabel)} · ~${currentLesson.estMinutes} min`,
      type: typeLabel,
    };
  }

  const remainingMinutes = lessonsInOrder
    .filter((l) => !completed.has(l.id))
    .reduce((sum, l) => sum + l.estMinutes, 0);

  // Distinct concepts across lessons, in first-seen order, humanized + capped.
  const seen = new Set<string>();
  const keyConcepts: string[] = [];
  for (const l of lessonsInOrder) {
    for (const c of l.conceptsTaught) {
      if (seen.has(c)) continue;
      seen.add(c);
      keyConcepts.push(humanizeConcept(c));
      if (keyConcepts.length >= MAX_KEY_CONCEPTS) break;
    }
    if (keyConcepts.length >= MAX_KEY_CONCEPTS) break;
  }

  const level = track.targetMastery ?? 'beginner';

  return {
    trackId: track.id,
    topic: track.topic,
    title: track.title ?? `${track.topic} course`,
    summary: track.summary,
    eyebrow: `${track.topic.toUpperCase()} · ${level.toUpperCase()}`,
    level,
    totalLessons,
    doneCount,
    progressPct: totalLessons > 0 ? Math.round((doneCount / totalLessons) * 100) : 0,
    timeRemainingLabel: remainingMinutes > 0 ? `≈${formatDuration(remainingMinutes)}` : '0m',
    totalTimeLabel: formatDuration(track.totalMinutes),
    sectionCount: track.sections.length,
    sections,
    continueLesson,
    keyConcepts,
  };
}

function continueTypeLabel(type: LessonTypeKind): string {
  switch (type) {
    case 'video':
      return 'Video';
    case 'embed':
      return 'Embed';
    default:
      return 'Reading';
  }
}
