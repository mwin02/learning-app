// Phase 2.75e (learn UI), rebuilt in frontend-redesign Block 2: the program
// overview as a notebook — the Desk, the bookmark rail (Overview tab active,
// one accent tab per course with real progress fractions), and the sheet with
// the plan as a table of contents. Unenrolled viewers (anonymous included)
// still get the EnrollPrompt from the layout; going through getProgramAccess
// keeps this page from ever rendering a less-sanitized view than it decided.

import { notFound } from 'next/navigation';
import { getProgramAccess } from '@/lib/auth/program-access';
import { getViewer } from '@/lib/auth/viewer';
import { loadProgramCourseProgress } from '@/lib/program-progress';
import { Desk, Sheet } from '@/components/notebook/Sheet';
import { BookmarkRail, BookmarkTab } from '@/components/notebook/BookmarkTab';
import { accentFor } from '@/components/notebook/accents';
import { NotebookProgramHome, romanize } from '../_components/NotebookProgramHome';
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
  const ordered = program.phases.flatMap((ph) => ph.tracks);
  const builtTrackIds = ordered.flatMap((t) =>
    t.trackId && trackBuildState(t) === 'ready' ? [t.trackId] : []
  );
  const progress = await loadProgramCourseProgress(viewer.userId, builtTrackIds);

  return (
    <Desk maxWidth={1120}>
      <BookmarkRail>
        <BookmarkTab
          kicker="Program"
          label="Overview"
          meta={`${program.builtCount}/${program.trackCount} ready`}
          bg="var(--color-nb-slate)"
          active
          href={`/programs/${program.id}`}
        />
        {ordered.map((track, i) => {
          const ready = track.trackId && trackBuildState(track) === 'ready';
          const cp = track.trackId ? progress.get(track.trackId) : undefined;
          return (
            <BookmarkTab
              key={track.topic}
              kicker={`Course ${romanize(i)}${cp ? ` · ${cp.doneCount}/${cp.totalCount}` : ''}`}
              label={track.title ?? track.topic}
              meta={ready ? `${track.lessonCount} lessons` : 'building…'}
              bg={accentFor(i).bg}
              href={ready ? `/programs/${program.id}/${track.trackId}` : undefined}
            />
          );
        })}
      </BookmarkRail>
      <Sheet>
        <NotebookProgramHome program={program} progress={progress} />
      </Sheet>
    </Desk>
  );
}
