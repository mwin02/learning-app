// Frontend redesign Block 1: the program-scoped course-player shell — the
// /learn/[trackId] layout re-homed under its program so navigation between a
// program's courses stays inside one URL subtree (the Block-2 accordion builds
// on this). Renders inside the program layout (which owns the top nav and the
// enrolled/login gate for its own subtree), but runs its own access check:
// getProgramTrackAccess also enforces plan membership and track readiness.
//
// Progress is still the per-track CourseProvider (program-wide provider is
// Block 3); basePath makes every player link resolve under this route.

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getProgramTrackAccess } from '@/lib/auth/program-track-access';
import { getViewer } from '@/lib/auth/viewer';
import { CourseProvider } from '@/app/learn/_components/course-context';
import { CourseSidebar } from '@/app/learn/_components/CourseSidebar';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ programId: string; trackId: string }>;
}): Promise<Metadata> {
  const { programId, trackId } = await params;
  const access = await getProgramTrackAccess(programId, trackId);
  if (access.kind !== 'ok') return {};
  return { title: access.track.title ?? `${access.track.topic} course` };
}

export default async function ProgramTrackLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ programId: string; trackId: string }>;
}) {
  const { programId, trackId } = await params;
  const access = await getProgramTrackAccess(programId, trackId);
  // Unenrolled (anonymous included): the program page shows the enroll prompt —
  // the intuitive landing for a shared course/lesson link.
  if (access.kind === 'unenrolled') redirect(`/programs/${programId}`);
  if (access.kind !== 'ok') notFound();

  const viewer = await getViewer();

  return (
    <CourseProvider
      track={access.track}
      signedIn={viewer.userId !== null}
      basePath={`/programs/${programId}/${trackId}`}
    >
      <div className="flex items-start">
        <CourseSidebar />
        <main className="min-h-[calc(100vh-var(--nav-h))] flex-1 min-w-0">{children}</main>
      </div>
    </CourseProvider>
  );
}
