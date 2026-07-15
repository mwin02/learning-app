// Phase 2.6 (learn UI), Block 2: the per-lesson content pane. Renders inside the
// shell layout (shared TopNav + CourseSidebar + CourseProvider), so this route only
// produces the main column. Model derivation lives in buildLessonViewModel (shared
// with the program-scoped player since frontend-redesign Block 1).
//
// Block 1 also demoted /learn to an admin viewer: a signed-in non-admin is
// redirected to the program-scoped route for this lesson (their enrollment is
// the only way they could see it here anyway).

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getAuthorizedTrackView } from '@/lib/auth/track-access';
import { getViewer } from '@/lib/auth/viewer';
import { findEnrolledProgramForTrack } from '@/lib/auth/program-track-access';
import { buildLessonViewModel } from '@/lib/lesson-view-model';
import { LessonView } from '../../_components/LessonView';

export const dynamic = 'force-dynamic';

// Tab title: "<lesson> · <course>". getAuthorizedTrackView is cache()'d (shared
// with the layout + page render), so this is free — and, like the layout's
// generateMetadata, it leaks nothing to viewers the page will bounce.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ trackId: string; lessonId: string }>;
}): Promise<Metadata> {
  const { trackId, lessonId } = await params;
  const access = await getAuthorizedTrackView(trackId);
  if (access.kind !== 'ok') return {};
  const lesson = access.track.lessons.find((l) => l.id === lessonId);
  if (!lesson) return {};
  return { title: `${lesson.title} · ${access.track.title ?? access.track.topic}` };
}

export default async function LessonPage({
  params,
}: {
  params: Promise<{ trackId: string; lessonId: string }>;
}) {
  const { trackId, lessonId } = await params;

  const viewer = await getViewer();
  if (viewer.userId && !viewer.isAdmin) {
    const programId = await findEnrolledProgramForTrack(viewer.userId, trackId);
    if (programId) redirect(`/programs/${programId}/${trackId}/${lessonId}`);
  }

  // Audit 6.1: authorize here, not just in the parent layout — Next.js layouts
  // are not a security boundary (a crafted flight request can render this page
  // segment alone). Mirrors the program-scoped player's lesson page, which
  // re-runs its own access check. cache()'d, so the normal path adds no queries.
  const access = await getAuthorizedTrackView(trackId);
  if (access.kind === 'login') {
    redirect(`/signin?next=${encodeURIComponent(`/learn/${trackId}/${lessonId}`)}`);
  }
  if (access.kind !== 'ok') notFound();

  const model = buildLessonViewModel(access.track, lessonId);
  if (!model) notFound();

  return <LessonView model={model} />;
}
