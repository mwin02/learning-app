'use client';

// Frontend redesign Block 3: the persistent program shell — the Desk, the
// live accordion bookmark rail, and the program-wide progress provider. The
// program layout renders this once for the whole /programs/[programId]
// subtree, so navigating between overview, courses, and lessons only swaps
// the main column while the rail keeps its state and updates live as lessons
// are toggled complete (the CourseContextBridge routes the player's toggles
// through the provider here).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { createProgressStore, type ProgressStore } from '@/lib/progress-store';
import { Desk } from '@/components/notebook/Sheet';
import {
  BookmarkRail,
  BookmarkTab,
  type TabLesson,
  type TabSection,
} from '@/components/notebook/BookmarkTab';
import { accentFor, romanize } from '@/components/notebook/accents';
import { groupLessonsBySection } from './program-ui';

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

type ProgramProgressValue = {
  completed: Set<string>;
  isComplete: (lessonId: string) => boolean;
  toggle: (trackId: string, lessonId: string) => void;
};

const ProgramProgressContext = createContext<ProgramProgressValue | null>(null);

export function useProgramProgress(): ProgramProgressValue {
  const ctx = useContext(ProgramProgressContext);
  if (!ctx) throw new Error('useProgramProgress must be used within ProgramShell');
  return ctx;
}

export function ProgramShell({
  programId,
  courses,
  initialCompleted,
  signedIn,
  children,
}: {
  programId: string;
  courses: RailCourse[];
  initialCompleted: string[];
  signedIn: boolean;
  children: React.ReactNode;
}) {
  // One persistence store per built track (DB-backed when signed in, else the
  // dev bypass's localStorage). Held in a stable map across re-renders; the
  // effect below reconciles it against `courses`, which arrives fresh from the
  // server on each render.
  const [stores] = useState(() => new Map<string, ProgressStore>());

  const [completed, setCompleted] = useState<Set<string>>(() => new Set(initialCompleted));

  // Ensure a store exists for every ready track. AutoRefresh flips a track
  // building→ready mid-session without remounting this shell, so a course that
  // finished after mount would otherwise have no store — its toggles would flip
  // in memory but never persist (stores.get → undefined). Runs on mount (seeds
  // the initial tracks) and whenever a refresh reveals a newly-built course; for
  // the signed-out dev bypass, newly added stores get their localStorage set
  // merged in (signed-in state is server-seeded and authoritative).
  useEffect(() => {
    const added: ProgressStore[] = [];
    for (const c of courses) {
      if (c.trackId && c.ready && !stores.has(c.trackId)) {
        const store = createProgressStore(c.trackId, signedIn);
        stores.set(c.trackId, store);
        added.push(store);
      }
    }
    if (signedIn || added.length === 0) return;
    let active = true;
    Promise.all(added.map((s) => s.load())).then((sets) => {
      if (!active) return;
      setCompleted((prev) => {
        const next = new Set(prev);
        for (const set of sets) for (const id of set) next.add(id);
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [courses, stores, signedIn]);

  const toggle = useCallback(
    (trackId: string, lessonId: string) => {
      const store = stores.get(trackId);
      setCompleted((prev) => {
        const willComplete = !prev.has(lessonId);
        const next = new Set(prev);
        if (willComplete) next.add(lessonId);
        else next.delete(lessonId);
        void store?.setComplete(lessonId, willComplete); // fire-and-forget persist
        return next;
      });
    },
    [stores]
  );

  const value = useMemo<ProgramProgressValue>(
    () => ({ completed, isComplete: (id) => completed.has(id), toggle }),
    [completed, toggle]
  );

  // Route-derived rail state: which course is open, which lesson is current.
  const params = useParams<{ trackId?: string; lessonId?: string }>();
  const activeTrackId = params.trackId ?? null;
  const activeLessonId = params.lessonId ?? null;

  // Course-level collapse: the route decides the default (the course you're in
  // is open), a chevron click overrides it per course. Navigating into a course
  // clears any stale "collapsed" override for it, so landing on a lesson URL
  // always reveals its course (and, inside the tab, its section auto-opens).
  // Route-change reconciliation uses the render-time state-adjustment pattern
  // (react.dev "adjusting state when props change"), not an effect.
  const [rail, setRail] = useState<{
    forTrack: string | null;
    overrides: Record<string, boolean>;
  }>({ forTrack: null, overrides: {} });
  if (rail.forTrack !== activeTrackId) {
    const overrides = { ...rail.overrides };
    if (activeTrackId) delete overrides[activeTrackId];
    setRail({ forTrack: activeTrackId, overrides });
  }
  const expandOverrides = rail.overrides;
  const setExpandOverride = (trackId: string, value: boolean) =>
    setRail((prev) => ({ ...prev, overrides: { ...prev.overrides, [trackId]: value } }));

  const builtCount = courses.filter((c) => c.ready).length;

  return (
    <ProgramProgressContext.Provider value={value}>
      <Desk maxWidth={1440}>
        <BookmarkRail>
          <BookmarkTab
            kicker="Program"
            label="Overview"
            meta={`${builtCount}/${courses.length} ready`}
            bg="var(--color-nb-slate)"
            active={activeTrackId === null}
            href={`/programs/${programId}`}
          />
          {courses.map((course, i) => {
            const isActive = course.trackId !== null && course.trackId === activeTrackId;
            const done = course.lessons.filter((l) => completed.has(l.id)).length;
            const base = `/programs/${programId}/${course.trackId}`;

            // `current` rides separately from the completion mark: the lesson
            // being viewed may itself be completed (state stays 'done').
            const toLesson = (l: RailCourse['lessons'][number]): TabLesson => ({
              id: l.id,
              title: l.title,
              state: completed.has(l.id) ? 'done' : 'todo',
              current: l.id === activeLessonId,
              href: `${base}/${l.id}`,
            });
            // Sectioned course → grouped (with an "Other" group for SetNull
            // ungrouped leftovers); a flat course renders a plain lesson list.
            let sections: TabSection[] | undefined;
            let lessons: TabLesson[] | undefined;
            if (course.ready) {
              const grouped = groupLessonsBySection(course.lessons, course.sections);
              if (grouped) {
                sections = grouped.map((g) => ({
                  id: g.id,
                  title: g.title,
                  lessons: g.lessons.map(toLesson),
                }));
              } else {
                lessons = course.lessons.map(toLesson);
              }
            }

            return (
              <BookmarkTab
                key={course.topic}
                kicker={`Course ${romanize(i)}${course.ready ? ` · ${done}/${course.lessons.length}` : ''}`}
                label={course.title ?? course.topic}
                meta={course.ready ? `${course.lessons.length} lessons` : 'building…'}
                bg={accentFor(i).bg}
                active={isActive}
                href={course.ready && course.trackId ? base : undefined}
                sections={sections}
                lessons={lessons}
                expanded={
                  course.trackId ? (expandOverrides[course.trackId] ?? isActive) : false
                }
                onToggleExpand={
                  course.ready && course.trackId
                    ? () => {
                        const id = course.trackId!;
                        setExpandOverride(id, !(expandOverrides[id] ?? isActive));
                      }
                    : undefined
                }
              />
            );
          })}
        </BookmarkRail>
        <main className="min-w-0 flex-1">{children}</main>
      </Desk>
    </ProgramProgressContext.Provider>
  );
}
