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
import { BookmarkRail, BookmarkStrip, BookmarkTab } from '@/components/notebook/BookmarkTab';
import { buildRailTabs, type RailCourse } from './program-ui';

export type { RailCourse };

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

  const tabs = buildRailTabs({
    programId,
    courses,
    completed,
    activeTrackId,
    activeLessonId,
  });

  return (
    <ProgramProgressContext.Provider value={value}>
      <Desk maxWidth={1440}>
        <BookmarkRail>
          {tabs.map((tab) => {
            const id = tab.trackId;
            const collapsible = id !== null && Boolean(tab.sections?.length || tab.lessons?.length);
            const expanded = id === null ? undefined : (expandOverrides[id] ?? tab.active);
            return (
              <BookmarkTab
                key={tab.key}
                kicker={tab.kicker}
                label={tab.label}
                meta={tab.meta}
                bg={tab.bg}
                active={tab.active}
                href={tab.href}
                sections={tab.sections}
                lessons={tab.lessons}
                expanded={expanded}
                onToggleExpand={
                  collapsible && id !== null
                    ? () => setExpandOverride(id, !(expandOverrides[id] ?? tab.active))
                    : undefined
                }
              />
            );
          })}
        </BookmarkRail>
        <div className="min-w-0 flex-1">
          <BookmarkStrip tabs={tabs} routeKey={activeLessonId ?? activeTrackId ?? 'overview'} />
          <main className="min-w-0">{children}</main>
        </div>
      </Desk>
    </ProgramProgressContext.Provider>
  );
}
