// Phase 2.75e (learn UI): the program-hub shell. Loads the ProgramView once (server,
// cache()'d so the page's load is free) and renders the design-system chrome — the
// surface background, the sticky ProgramTopNav, and the sticky ProgramSidebar listing
// the constituent Tracks — around the main column. Mirrors the course player's
// /learn/[trackId] layout one level up, but the program hub needs no client progress
// provider: it's a read-only overview that links into each Track's own player.
//
// Phase 3d: gated. Anonymous → sign-in (with a return path). Signed-in but
// unenrolled → the EnrollPrompt stub instead of the hub (enrollment is free).
// Non-creators — enrolled or not — only ever receive the sanitized view (the
// generated title/description; the creator's goal/background never leave the server).

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getProgramAccess } from '@/lib/auth/program-access';
import { getViewer } from '@/lib/auth/viewer';
import { ProgramTopNav } from '../_components/ProgramTopNav';
import { ProgramSidebar } from '../_components/ProgramSidebar';
import { EnrollPrompt } from '../_components/EnrollPrompt';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ programId: string }>;
}): Promise<Metadata> {
  const { programId } = await params;
  const viewer = await getViewer();
  if (!viewer.userId && !viewer.isAdmin) return {};
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
  const viewer = await getViewer();
  if (!viewer.userId && !viewer.isAdmin) {
    redirect(`/auth/login?next=${encodeURIComponent(`/programs/${programId}`)}`);
  }

  const access = await getProgramAccess(programId);
  if (!access) notFound();
  if (!access.enrolled) return <EnrollPrompt program={access.view} />;

  const program = access.view;
  return (
    <div className="min-h-screen bg-surface text-ink">
      <ProgramTopNav builtCount={program.builtCount} trackCount={program.trackCount} />
      <div className="flex items-start">
        <ProgramSidebar program={program} />
        <main className="min-h-[calc(100vh-var(--nav-h))] flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
