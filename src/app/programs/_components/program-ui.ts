// Phase 2.75e (learn UI): shared presentational helpers for the public program hub.
// Token-only (no raw hex/px) so the pages flip with the design system + dark mode.
import type { ProgramStatus } from '@prisma/client';
import type { ProgramTrackView, ProgramView } from '@/lib/program-view';

// A track slot's coarse build state, derived from the built Track's status (if any)
// else the child request's status. Drives the row dot + badge.
export type TrackBuildState = 'ready' | 'building' | 'failed';

export function trackBuildState(t: ProgramTrackView): TrackBuildState {
  if (t.trackId && t.trackStatus === 'ready') return 'ready';
  if (t.requestStatus === 'failed' || t.trackStatus === 'failed') return 'failed';
  return 'building';
}

// The built (ready) track ids of a program, in plan order — the set a progress
// read (loadProgramCourseProgress) and the rail render over. One definition so
// the overview, enroll preview, and shell never gate on subtly different rules.
export function readyTrackIds(program: ProgramView): string[] {
  return program.phases
    .flatMap((ph) => ph.tracks)
    .flatMap((t) => (t.trackId && trackBuildState(t) === 'ready' ? [t.trackId] : []));
}

// Group a course's lessons under its sections the way both the rail and the
// enroll preview do: each section keeps its lessons in track order, and any
// section-less leftovers (SetNull ungrouped) collect into a trailing "Other"
// group. Returns null for a flat (un-sectioned) course so callers render a
// plain lesson list. Generic over the lesson shape — only `sectionId` is read.
export function groupLessonsBySection<L extends { sectionId: string | null }>(
  lessons: L[],
  sections: { id: string; title: string }[]
): { id: string; title: string; lessons: L[] }[] | null {
  if (sections.length === 0) return null;
  const groups = sections.map((s) => ({
    id: s.id,
    title: s.title,
    lessons: lessons.filter((l) => l.sectionId === s.id),
  }));
  const loose = lessons.filter((l) => l.sectionId === null);
  if (loose.length > 0) groups.push({ id: '__loose', title: 'Other', lessons: loose });
  return groups;
}

// Badge classes per build state (token utilities only — no danger token exists, so
// `failed` uses the neutral fill treatment with muted text).
export const TRACK_STATE_BADGE: Record<TrackBuildState, string> = {
  ready: 'bg-success-bg text-success',
  building: 'bg-fill text-muted',
  failed: 'bg-fill text-muted',
};

export const TRACK_STATE_LABEL: Record<TrackBuildState, string> = {
  ready: 'Ready',
  building: 'Building…',
  failed: 'Unavailable',
};

// The program-level status shown in the shell header.
export const PROGRAM_STATE_LABEL: Record<ProgramStatus, string> = {
  planning: 'Planning…',
  building: 'Building…',
  ready: 'Ready',
  partial: 'Partly ready',
  failed: 'Failed',
};
