// Frontend redesign Block 1, reskinned in Block 4: the program-scoped course
// home. The [trackId] layout already gated access and bridged the shell's
// progress into the CourseContext; this route renders the notebook sheet.
//
// Reports R8: it also carries the rebuild affordance. It goes here rather than in
// the layout because the layout's children ARE the sheet — a sibling banner would
// join the shell's flex row next to the rail.

import { Sheet } from '@/components/notebook/Sheet';
import { NotebookCourseHome } from '@/app/programs/_components/NotebookCourseHome';
import { RebuildNotice } from '@/app/programs/_components/RebuildNotice';
import { getProgramTrackAccess } from '@/lib/auth/program-track-access';
import { latestRebuildFor, rebuildNotice } from '@/lib/services/rebuild-activity';

export const dynamic = 'force-dynamic';

export default async function ProgramCourseHomePage({
  params,
}: {
  params: Promise<{ programId: string; trackId: string }>;
}) {
  const { programId, trackId } = await params;
  // cache()'d — deduped with the layout's own check, which owns the 404/redirect
  // outcomes. Here it is only the gate on querying rebuild state at all.
  const access = await getProgramTrackAccess(programId, trackId);
  const notice = access.kind === 'ok' ? rebuildNotice(await latestRebuildFor(programId, trackId)) : null;

  return (
    <Sheet>
      {notice && <RebuildNotice notice={notice} />}
      <NotebookCourseHome />
    </Sheet>
  );
}
