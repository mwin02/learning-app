// Frontend redesign Block 1: the per-lesson view-model builder, extracted from
// the /learn lesson page so the program-scoped player builds the identical
// model. Pure derivation over the TrackView; returns null when the lesson
// isn't in this track (callers 404).

import { lessonTypeOf, humanizeConcept } from '@/lib/course-home-model';
import type { TrackView } from '@/lib/track-view';
import type { LessonViewModel } from '@/app/learn/_components/LessonView';

export function buildLessonViewModel(track: TrackView, lessonId: string): LessonViewModel | null {
  const idx = track.lessons.findIndex((l) => l.id === lessonId);
  if (idx === -1) return null;
  const lesson = track.lessons[idx];

  // Eyebrow context: section number (position in track order) + the lesson's index
  // within its own section. Flat tracks (no sections / null sectionId) fall back to
  // the lesson's global position.
  const sectionIdx = lesson.sectionId
    ? track.sections.findIndex((s) => s.id === lesson.sectionId)
    : -1;
  const section = sectionIdx === -1 ? null : track.sections[sectionIdx];
  const lessonNumInSection = section
    ? track.lessons.filter((l) => l.sectionId === section.id).findIndex((l) => l.id === lessonId) +
      1
    : idx + 1;
  const eyebrow = section
    ? `SECTION ${sectionIdx + 1} · ${section.title.toUpperCase()} · LESSON ${lessonNumInSection}`
    : `LESSON ${idx + 1} OF ${track.lessons.length}`;

  const prev = idx > 0 ? track.lessons[idx - 1] : null;
  const next = idx < track.lessons.length - 1 ? track.lessons[idx + 1] : null;

  return {
    id: lesson.id,
    trackId: track.id,
    eyebrow,
    title: lesson.title,
    type: lessonTypeOf(lesson),
    summary: lesson.summary,
    concepts: lesson.conceptsTaught.map(humanizeConcept),
    estMinutes: lesson.estMinutes,
    resources: lesson.resources,
    exercises: lesson.exercises,
    prev: prev ? { id: prev.id, title: prev.title } : null,
    next: next
      ? { id: next.id, title: next.title, type: lessonTypeOf(next), estMinutes: next.estMinutes }
      : null,
  };
}
