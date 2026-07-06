// Frontend redesign Block 1: the program-scoped lesson pane. Renders inside
// the [trackId] shell (shared CourseSidebar + CourseProvider); this route only
// produces the main column. getProgramTrackAccess is cache()'d — deduped with
// the layout's check in the same request.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProgramTrackAccess } from '@/lib/auth/program-track-access';
import { buildLessonViewModel } from '@/lib/lesson-view-model';
import { LessonView } from '@/app/learn/_components/LessonView';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ programId: string; trackId: string; lessonId: string }>;
}): Promise<Metadata> {
  const { programId, trackId, lessonId } = await params;
  const access = await getProgramTrackAccess(programId, trackId);
  if (access.kind !== 'ok') return {};
  const lesson = access.track.lessons.find((l) => l.id === lessonId);
  if (!lesson) return {};
  return { title: `${lesson.title} · ${access.track.title ?? access.track.topic}` };
}

export default async function ProgramLessonPage({
  params,
}: {
  params: Promise<{ programId: string; trackId: string; lessonId: string }>;
}) {
  const { programId, trackId, lessonId } = await params;
  const access = await getProgramTrackAccess(programId, trackId);
  if (access.kind !== 'ok') notFound(); // layout handles the redirect cases

  const model = buildLessonViewModel(access.track, lessonId);
  if (!model) notFound();

  return <LessonView model={model} />;
}
