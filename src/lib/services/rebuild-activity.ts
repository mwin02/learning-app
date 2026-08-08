// Reports R8: what the course page must say while a rebuild of THIS Track is in
// flight, and after one failed.
//
// R5 leaves the Program `ready` throughout a rebuild on purpose, and the program
// layout only mounts AutoRefresh for a `planning`/`building` Program — so before
// this module the dialog's "your new course appears here when it is ready" was a
// promise nothing kept: the page never re-rendered, and a failed rebuild said
// nothing at all. The notice is derived from the rebuild's own CourseRequest rather
// than from Program.status, which is the state that actually moves.
//
// Not scoped to the viewer: any enrolled learner's rebuild repoints the slot for
// everyone in the program, so everyone reading the course should know it is changing.

import { CourseRequestStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { REBUILD_FAILURE_NOTICE_MS, TRACK_REBUILD_DEDUP_WINDOW_MS } from '@/lib/config';

export type LatestRebuild = {
  status: CourseRequestStatus;
  // When the learner asked for it — the age the rebuild dialog's own dedup window is
  // measured from, so the banner and the dialog stop describing the same row differently.
  createdAt: Date;
  // Last state change — the finish write for a terminal row.
  updatedAt: Date;
  // Any sibling request of this program still queued/running. maybeAssembleProgram
  // returns early while one is, so a fulfilled rebuild's slot repoint is BLOCKED for
  // the whole duration of an unrelated build in the same program — minutes to tens of
  // minutes. That is program state, not a wall clock, and it is what keeps the
  // "rebuilding" affordance alive across it.
  siblingsInFlight: boolean;
};

type NoticeCopy = { title: string; detail: string };

export type RebuildNotice = NoticeCopy & { kind: 'building' | 'failed' };

const BUILDING: NoticeCopy = {
  title: 'Rebuilding this course…',
  detail:
    'This takes a few minutes. The page updates itself when the new version is ready, and your finished lessons come with it.',
};

const FAILED: NoticeCopy = {
  title: 'The last rebuild didn’t finish',
  detail:
    'This course is unchanged and the attempt did not use up one of your monthly rebuilds. You can ask for another one below.',
};

export function rebuildNotice(latest: LatestRebuild | null, now: Date = new Date()): RebuildNotice | null {
  if (!latest) return null;
  // Bounded against the SAME window regenerateTrack dedups on: past it, the dialog
  // treats this request as abandoned and offers a fresh rebuild, so the banner must
  // stop saying "rebuilding" too — and AutoRefresh must stop issuing an RSC fetch
  // every 5s for the lifetime of the tab. Workers down for an hour (the merge →
  // worker-reset window) is the ordinary trigger, not an exotic one.
  const live = now.getTime() - latest.createdAt.getTime() < TRACK_REBUILD_DEDUP_WINDOW_MS;
  switch (latest.status) {
    case CourseRequestStatus.queued:
    case CourseRequestStatus.running:
      return live ? { kind: 'building', ...BUILDING } : null;
    // Fulfilled and we are still rendering the OLD Track, so the slot repoint has not
    // committed. Either a sibling build is holding the assembler off (state, however
    // long it takes), or it is about to commit in the worker's own next statement.
    // The moved-URL redirect is what ends this state; the bound is the backstop for a
    // repoint that never comes at all.
    case CourseRequestStatus.fulfilled:
      return latest.siblingsInFlight || live ? { kind: 'building', ...BUILDING } : null;
    case CourseRequestStatus.failed:
      return now.getTime() - latest.updatedAt.getTime() < REBUILD_FAILURE_NOTICE_MS
        ? { kind: 'failed', ...FAILED }
        : null;
  }
}

// The most recent rebuild REQUEST for this Track, whatever state it is in. Latest
// only: an older failure behind a newer in-flight attempt is not what the learner
// needs told, and `replacesTrackId` is not an FK (R5), so this is an id match.
//
// The sibling count is the assembler's own precondition, read back: it costs a second
// query and only runs for a fulfilled rebuild, which is the one state where "has the
// repoint happened yet" is not answerable from the request row alone.
export async function latestRebuildFor(programId: string, trackId: string): Promise<LatestRebuild | null> {
  const latest = await prisma.courseRequest.findFirst({
    where: { programId, replacesTrackId: trackId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, createdAt: true, updatedAt: true },
  });
  if (!latest) return null;
  const siblingsInFlight =
    latest.status === CourseRequestStatus.fulfilled &&
    (await prisma.courseRequest.count({
      where: {
        programId,
        status: { in: [CourseRequestStatus.queued, CourseRequestStatus.running] },
      },
    })) > 0;
  return { ...latest, siblingsInFlight };
}
