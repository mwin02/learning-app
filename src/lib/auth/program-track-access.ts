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
import { resolveReplacementTrack } from '@/lib/services/track-replacement';
import { CourseRequestStatus } from '@prisma/client';

export type ProgramTrackAccess =
  | { kind: 'ok'; program: ProgramAccess; track: TrackView }
  // Real program, viewer not enrolled (anonymous included — programs are
  // publicly previewable) — bounce to the program page's enroll prompt instead
  // of 404ing something we happily show a preview of.
  | { kind: 'unenrolled' }
  // Reports R8: this Track was rebuilt and the plan slot now points at another
  // one, so the learner's own URL names a Track that is no longer a member.
  // Distinct from not_found so callers redirect instead of 404ing a course the
  // viewer was mid-way through.
  | { kind: 'moved'; trackId: string }
  | { kind: 'not_found' };

export const getProgramTrackAccess = cache(
  async (programId: string, trackId: string): Promise<ProgramTrackAccess> => {
    const viewer = await getViewer();
    const program = await getProgramAccess(programId);
    if (!program) return { kind: 'not_found' };
    if (!program.enrolled) return { kind: 'unenrolled' };

    // Membership comes from the already-loaded plan — no extra query.
    const memberIds = new Set(
      program.view.phases.flatMap((ph) => ph.tracks.map((t) => t.trackId).filter((id) => id !== null)),
    );
    if (!memberIds.has(trackId)) {
      const moved = await findReplacementTrack(programId, trackId, memberIds);
      return moved ? { kind: 'moved', trackId: moved } : { kind: 'not_found' };
    }

    const track = await getTrackView(trackId);
    if (!track) return { kind: 'not_found' };
    if (track.status !== 'ready' && !viewer.isAdmin) return { kind: 'not_found' };

    return { kind: 'ok', program, track };
  }
);

// Reports R8: only reached when the requested Track is NOT in the plan, so the
// normal path still costs no extra query. Scoped to this Program's own rebuild
// requests — a Track's replacement is only meaningful for the plan that repointed
// at it, and cross-program resolution would hand out a course this URL never named.
async function findReplacementTrack(
  programId: string,
  oldTrackId: string,
  memberIds: ReadonlySet<string>,
): Promise<string | null> {
  const rebuilds = await prisma.courseRequest.findMany({
    where: {
      programId,
      status: CourseRequestStatus.fulfilled,
      replacesTrackId: { not: null },
      trackId: { not: null },
    },
    // Oldest first: resolveReplacementTrack lets later edges win, matching the
    // order the assembler applies its repoints in.
    orderBy: { createdAt: 'asc' },
    select: { trackId: true, replacesTrackId: true },
  });
  const edges = rebuilds.flatMap((r) =>
    r.trackId && r.replacesTrackId ? [{ trackId: r.trackId, replacesTrackId: r.replacesTrackId }] : [],
  );
  return resolveReplacementTrack(oldTrackId, edges, (id) => memberIds.has(id));
}

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
