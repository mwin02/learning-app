// Frontend redesign Block 1, reskinned in Block 5: the program-scoped lesson
// pane. The [trackId] layout gated access and bridged the shell's progress
// into the CourseContext; this route renders the notebook sheet.
// getProgramTrackAccess is cache()'d — deduped with the layout's check.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProgramTrackAccess } from '@/lib/auth/program-track-access';
import { buildLessonViewModel } from '@/lib/lesson-view-model';
import { Sheet } from '@/components/notebook/Sheet';
import { NotebookLessonView } from '@/app/programs/_components/NotebookLessonView';

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

  return (
    <Sheet>
      <NotebookLessonView model={model} />
    </Sheet>
  );
}
