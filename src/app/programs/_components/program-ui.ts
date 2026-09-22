// Phase 2.75e (learn UI): shared presentational helpers for the public program hub.
// Token-only (no raw hex/px) so the pages flip with the design system + dark mode.
import type { ProgramStatus } from '@prisma/client';
import type { ProgramTrackView, ProgramView } from '@/lib/program-view';
import type { RailTab, TabLesson } from '@/components/notebook/BookmarkTab';
import { accentFor, romanize } from '@/components/notebook/accents';

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

// One rail entry per plan slot, in program order. Unready slots have trackId
// null (or a non-ready track) and render inert.
export type RailCourse = {
  trackId: string | null;
  ready: boolean;
  topic: string;
  title: string | null;
  lessons: { id: string; title: string; sectionId: string | null }[];
  sections: { id: string; title: string }[];
};

export function buildRailTabs({
  programId,
  courses,
  completed,
  activeTrackId,
  activeLessonId,
}: {
  programId: string;
  courses: RailCourse[];
  completed: ReadonlySet<string>;
  activeTrackId: string | null;
  activeLessonId: string | null;
}): RailTab[] {
  const builtCount = courses.filter((c) => c.ready).length;

  const overview: RailTab = {
    key: '__overview',
    trackId: null,
    kicker: 'Program',
    label: 'Overview',
    meta: `${builtCount}/${courses.length} ready`,
    bg: 'var(--color-nb-slate)',
    active: activeTrackId === null,
    href: `/programs/${programId}`,
  };

  return [
    overview,
    ...courses.map((course, i): RailTab => {
      const active = course.trackId !== null && course.trackId === activeTrackId;
      const done = course.lessons.filter((l) => completed.has(l.id)).length;
      const base = `/programs/${programId}/${course.trackId}`;

      // `current` rides separately from the completion mark: the lesson being
      // viewed may itself be completed (state stays 'done').
      const toLesson = (l: RailCourse['lessons'][number]): TabLesson => ({
        id: l.id,
        title: l.title,
        state: completed.has(l.id) ? 'done' : 'todo',
        current: l.id === activeLessonId,
        href: `${base}/${l.id}`,
      });

      // Sectioned course → grouped (with an "Other" group for SetNull ungrouped
      // leftovers); a flat course renders a plain lesson list.
      const grouped = course.ready
        ? groupLessonsBySection(course.lessons, course.sections)
        : null;

      return {
        key: course.topic,
        trackId: course.trackId,
        kicker: `Course ${romanize(i)}${course.ready ? ` · ${done}/${course.lessons.length}` : ''}`,
        label: course.title ?? course.topic,
        meta: course.ready ? `${course.lessons.length} lessons` : 'building…',
        bg: accentFor(i).bg,
        active,
        href: course.ready && course.trackId ? base : undefined,
        sections: grouped
          ? grouped.map((g) => ({ id: g.id, title: g.title, lessons: g.lessons.map(toLesson) }))
          : undefined,
        lessons: course.ready && !grouped ? course.lessons.map(toLesson) : undefined,
      };
    }),
  ];
}
