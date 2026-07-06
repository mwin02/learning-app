// Phase 2.75e (learn UI), rebuilt in frontend-redesign Blocks 2–3: the program
// overview sheet. The layout owns the persistent shell (Desk + rail + progress
// provider); this route renders only the main column — the notebook Sheet with
// the plan as a table of contents. Unenrolled viewers (anonymous included)
// get the EnrollPrompt from the layout; going through getProgramAccess keeps
// this page from ever rendering a less-sanitized view than it decided.

import { notFound } from 'next/navigation';
import { getProgramAccess } from '@/lib/auth/program-access';
import { getViewer } from '@/lib/auth/viewer';
import { loadProgramCourseProgress } from '@/lib/program-progress';
import { Sheet } from '@/components/notebook/Sheet';
import { NotebookProgramHome } from '../_components/NotebookProgramHome';
import { trackBuildState } from '../_components/program-ui';

export const dynamic = 'force-dynamic';

export default async function ProgramHomePage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const [viewer, access] = await Promise.all([getViewer(), getProgramAccess(programId)]);
  if (!access) notFound();
  if (!access.enrolled) return null; // the layout renders the EnrollPrompt instead

  const program = access.view;
  const builtTrackIds = program.phases
    .flatMap((ph) => ph.tracks)
    .flatMap((t) => (t.trackId && trackBuildState(t) === 'ready' ? [t.trackId] : []));
  // cache()-free but cheap; re-runs per navigation so the ToC counts stay fresh.
  const progress = await loadProgramCourseProgress(viewer.userId, builtTrackIds);

  return (
    <Sheet>
      <NotebookProgramHome program={program} progress={progress} />
    </Sheet>
  );
}
