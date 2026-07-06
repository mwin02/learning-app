// Frontend redesign Block 1, slimmed in Block 3: the program-scoped course
// player segment. The program layout above owns all chrome (Desk, rail,
// progress provider); this layout only runs the track-level access check and
// bridges the shell's program-wide progress into the player's CourseContext,
// so CourseHome / LessonView run unchanged and their toggles move the rail.

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getProgramTrackAccess } from '@/lib/auth/program-track-access';
import { CourseContextBridge } from '@/app/programs/_components/CourseContextBridge';

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
  // Unenrolled (anonymous included): the program layout shows the enroll
  // prompt before children render, so this redirect is defense-in-depth.
  if (access.kind === 'unenrolled') redirect(`/programs/${programId}`);
  if (access.kind !== 'ok') notFound();

  return (
    <CourseContextBridge track={access.track} basePath={`/programs/${programId}/${trackId}`}>
      {/* The shell's Desk sets the handwriting font; the player pages are
          still the old design system, so pin them back to sans until their
          notebook re-skins land. */}
      <div className="font-sans text-ink">{children}</div>
    </CourseContextBridge>
  );
}
