// Phase 2.75e (learn UI): the program-hub home page. The shell layout already loaded
// (and cache()'d) the access-checked ProgramView, so the re-read here is free; going
// through getProgramAccess means the page can never render a less-sanitized view
// than the layout decided. Unenrolled viewers (anonymous included — programs are
// publicly previewable) get the EnrollPrompt here at the program URL.

import { notFound } from 'next/navigation';
import { getProgramAccess } from '@/lib/auth/program-access';
import { ProgramHome } from '../_components/ProgramHome';
import { ProgramSidebar } from '../_components/ProgramSidebar';

export const dynamic = 'force-dynamic';

export default async function ProgramHomePage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const access = await getProgramAccess(programId);
  if (!access) notFound();
  if (!access.enrolled) return null; // the layout renders the EnrollPrompt instead
  // Block 1: the sidebar lives here (not the layout) so the nested [trackId]
  // player can render the CourseSidebar instead. cache() makes the re-read free.
  return (
    <div className="flex items-start">
      <ProgramSidebar program={access.view} />
      <main className="min-h-[calc(100vh-var(--nav-h))] flex-1 min-w-0">
        <ProgramHome program={access.view} />
      </main>
    </div>
  );
}
