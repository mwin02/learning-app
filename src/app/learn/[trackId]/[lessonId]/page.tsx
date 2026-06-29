// Phase 2.6 (learn UI), Block 2: the per-lesson content pane. Renders inside the
// shell layout (shared TopNav + CourseSidebar + CourseProvider), so this route only
// produces the main column. Re-calls getTrackView (cache()'d — deduped with the
// layout's load in the same request), finds the lesson by id, and derives the
// serializable view-model the client LessonView renders. The resource player itself
// lands in Block 3; this block scaffolds everything around it.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTrackView } from '@/lib/track-view';
import { lessonTypeOf, humanizeConcept } from '@/lib/course-home-model';
import { LessonView, type LessonViewModel } from '../../_components/LessonView';

export const dynamic = 'force-dynamic';

// Tab title: "<lesson> · <course>". getTrackView is cache()'d (shared with the
// layout + page render), so this is free.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ trackId: string; lessonId: string }>;
}): Promise<Metadata> {
  const { trackId, lessonId } = await params;
  const track = await getTrackView(trackId);
  const lesson = track?.lessons.find((l) => l.id === lessonId);
  if (!track || !lesson) return {};
  return { title: `${lesson.title} · ${track.title ?? track.topic}` };
}

export default async function LessonPage({
  params,
}: {
  params: Promise<{ trackId: string; lessonId: string }>;
}) {
  const { trackId, lessonId } = await params;
  const track = await getTrackView(trackId);
  if (!track) notFound();

  const idx = track.lessons.findIndex((l) => l.id === lessonId);
  if (idx === -1) notFound();
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

  const model: LessonViewModel = {
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

  return <LessonView model={model} />;
}
