// Phase 2.75e (learn UI): the program-hub shell. Loads the ProgramView once (server,
// cache()'d so the pages' loads are free) and renders the shared chrome — the
// surface background and the sticky ProgramTopNav — around the child routes: the
// program home (which brings its own ProgramSidebar) and, since frontend-redesign
// Block 1, the nested [trackId] course player (which brings the CourseSidebar).
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
  return (
    <>
      {/* Phase 3e: live build status — re-render the (force-dynamic) hub while in flight. */}
      {(program.status === 'planning' || program.status === 'building') && <AutoRefresh />}
      {/* Block 2 (frontend redesign): no shared chrome here — the notebook
          program home brings its own Desk/rail/Sheet; the (not yet converted)
          [trackId] player brings the old ProgramTopNav + CourseSidebar. */}
      {children}
    </>
  );
}
