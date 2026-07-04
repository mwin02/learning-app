// Phase 2.6 (learn UI), Block C: the course home/summary page. The shell layout
// already loaded the Track into the CourseProvider, so this route just renders the
// main column. Frontend-redesign Block 1 demoted /learn to an admin viewer: a
// signed-in non-admin is redirected to the program-scoped player.

import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { findEnrolledProgramForTrack } from '@/lib/auth/program-track-access';
import { CourseHome } from '../_components/CourseHome';

export const dynamic = 'force-dynamic';

export default async function CourseHomePage({
  params,
}: {
  params: Promise<{ trackId: string }>;
}) {
  const { trackId } = await params;

  const viewer = await getViewer();
  if (viewer.userId && !viewer.isAdmin) {
    const programId = await findEnrolledProgramForTrack(viewer.userId, trackId);
    if (programId) redirect(`/programs/${programId}/${trackId}`);
  }

  return <CourseHome />;
}
