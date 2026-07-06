// Frontend redesign Block 1: authorized loader for the PROGRAM-SCOPED course
// player (/programs/[programId]/[trackId]). Composes the program access check
// with the track view: the viewer must see the program, be enrolled, and the
// track must be a member of the program's plan and `ready`. Distinct outcomes
// so the layout can route each case; unauthorized === nonexistent (404) as
// everywhere else. cache()'d — the [trackId] layout, its pages, and
// generateMetadata share one resolution per request.

import { cache } from 'react';
import { prisma } from '@/lib/db';
import { getProgramAccess, type ProgramAccess } from '@/lib/auth/program-access';
import { getTrackView, type TrackView } from '@/lib/track-view';
import { getViewer } from '@/lib/auth/viewer';

export type ProgramTrackAccess =
  | { kind: 'ok'; program: ProgramAccess; track: TrackView }
  // Real program, viewer not enrolled (anonymous included — programs are
  // publicly previewable) — bounce to the program page's enroll prompt instead
  // of 404ing something we happily show a preview of.
  | { kind: 'unenrolled' }
  | { kind: 'not_found' };

export const getProgramTrackAccess = cache(
  async (programId: string, trackId: string): Promise<ProgramTrackAccess> => {
    const viewer = await getViewer();
    const program = await getProgramAccess(programId);
    if (!program) return { kind: 'not_found' };
    if (!program.enrolled) return { kind: 'unenrolled' };

    // Membership comes from the already-loaded plan — no extra query.
    const member = program.view.phases.some((ph) => ph.tracks.some((t) => t.trackId === trackId));
    if (!member) return { kind: 'not_found' };

    const track = await getTrackView(trackId);
    if (!track) return { kind: 'not_found' };
    if (track.status !== 'ready' && !viewer.isAdmin) return { kind: 'not_found' };

    return { kind: 'ok', program, track };
  }
);

// For the /learn → program-scoped redirect: some Program this user is enrolled
// in whose plan contains this track. Oldest enrollment wins for determinism.
export const findEnrolledProgramForTrack = cache(
  async (userId: string, trackId: string): Promise<string | null> => {
    const row = await prisma.enrolledProgram.findFirst({
      where: { userId, program: { programPaths: { some: { trackId } } } },
      orderBy: { enrolledAt: 'asc' },
      select: { programId: true },
    });
    return row?.programId ?? null;
  }
);
