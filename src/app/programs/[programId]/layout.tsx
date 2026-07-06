// Phase 2.75e (learn UI), rebuilt in frontend-redesign Block 3: the PERSISTENT
// program shell. For enrolled viewers this layout renders the ProgramShell
// (Desk + live accordion bookmark rail + program-wide progress provider) once
// for the whole /programs/[programId] subtree — overview, courses, and lessons
// only swap the main column, and the rail updates live as lessons are toggled
// (the [trackId] CourseContextBridge routes the player's toggles through the
// shell's provider).
//
// Phase 3d, revised in frontend-redesign Block 1: programs are PUBLICLY
// previewable. Anonymous and signed-in-but-unenrolled viewers both get the
// EnrollPrompt (the prompt's CTA is "sign in" vs "enroll" respectively) — no
// more bouncing straight into Google OAuth from a shared link. Non-creators —
// enrolled or not — only ever receive the sanitized view (the generated
// title/description; the creator's goal/background never leave the server).

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { EnrollPrompt } from '../_components/EnrollPrompt';
import { getProgramAccess } from '@/lib/auth/program-access';
import { AutoRefresh } from '../_components/AutoRefresh';
import { ProgramShell, type RailCourse } from '../_components/ProgramShell';
import { loadProgramCourseProgress } from '@/lib/program-progress';
import { trackBuildState } from '../_components/program-ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ programId: string }>;
}): Promise<Metadata> {
  const { programId } = await params;
  const access = await getProgramAccess(programId);
  if (!access) return {};
  return { title: access.view.title ?? access.view.goal };
}

export default async function ProgramLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const [viewer, access] = await Promise.all([getViewer(), getProgramAccess(programId)]);
  if (!access) notFound();
  // Unenrolled (anonymous included): the prompt renders AT the requested URL —
  // deep course/lesson links keep their path on purpose, so signing in from one
  // (the prompt's CTA carries the current path as `next`) drops an already-
  // enrolled user exactly where the link pointed.
  if (!access.enrolled) {
    return <EnrollPrompt program={access.view} signedIn={viewer.userId !== null} />;
  }

  const program = access.view;

  // Rail data: every plan slot in program order, with lesson skeletons +
  // the viewer's completed ids for the built ones (seeds the live provider).
  const ordered = program.phases.flatMap((ph) => ph.tracks);
  const readyTrackIds = ordered.flatMap((t) =>
    t.trackId && trackBuildState(t) === 'ready' ? [t.trackId] : []
  );
  const progress = await loadProgramCourseProgress(viewer.userId, readyTrackIds);
  const courses: RailCourse[] = ordered.map((t) => {
    const ready = Boolean(t.trackId && trackBuildState(t) === 'ready');
    const cp = ready ? progress.get(t.trackId!) : undefined;
    return {
      trackId: t.trackId,
      ready,
      topic: t.topic,
      title: t.title,
      lessons: cp?.lessons ?? [],
      sections: cp?.sections ?? [],
    };
  });
  const initialCompleted = [...progress.values()].flatMap((cp) => cp.completedIds);

  return (
    <>
      {/* Phase 3e: live build status — re-render the (force-dynamic) hub while in flight. */}
      {(program.status === 'planning' || program.status === 'building') && <AutoRefresh />}
      <ProgramShell
        programId={program.id}
        courses={courses}
        initialCompleted={initialCompleted}
        signedIn={viewer.userId !== null}
      >
        {children}
      </ProgramShell>
    </>
  );
}
