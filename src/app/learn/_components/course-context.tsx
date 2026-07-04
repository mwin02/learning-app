'use client';

// Phase 2.6 (learn UI): the client-side course context. Holds the learner's
// completed-lesson set (Progress table when signed in, localStorage otherwise —
// Phase 3f) and exposes the derived CourseHomeModel so the sidebar (layout) and
// the main column (page) re-render from one shared source as lessons are marked
// complete.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { TrackView } from '@/lib/track-view';
import { buildCourseHomeModel, type CourseHomeModel } from '@/lib/course-home-model';
import { createProgressStore } from '@/lib/progress-store';

type CourseContextValue = {
  model: CourseHomeModel;
  isComplete: (lessonId: string) => boolean;
  toggleComplete: (lessonId: string) => void;
};

const CourseContext = createContext<CourseContextValue | null>(null);

export function CourseProvider({
  track,
  signedIn,
  children,
}: {
  track: TrackView;
  // From the server layout (it knows the viewer): true only for a real session
  // with a userId — the dev bypass's userId-less viewer stays on localStorage.
  signedIn: boolean;
  children: React.ReactNode;
}) {
  // The persistence backend (DB when signed in, localStorage otherwise) behind a
  // stable interface — the provider never touches storage directly.
  const store = useMemo(() => createProgressStore(track.id, signedIn), [track.id, signedIn]);

  // Start empty on both server and first client render to avoid a hydration
  // mismatch; hydrate from the store after mount. setState lands in an async .then,
  // not synchronously in the effect body. `active` guards against a track switch.
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    store.load().then((set) => {
      if (active) setCompleted(set);
    });
    return () => {
      active = false;
    };
  }, [store]);

  const toggleComplete = useCallback(
    (lessonId: string) => {
      const willComplete = !completed.has(lessonId);
      const next = new Set(completed);
      if (willComplete) next.add(lessonId);
      else next.delete(lessonId);
      setCompleted(next); // optimistic
      void store.setComplete(lessonId, willComplete); // fire-and-forget persist
    },
    [completed, store],
  );

  const model = useMemo(() => buildCourseHomeModel(track, completed), [track, completed]);

  const value = useMemo<CourseContextValue>(
    () => ({
      model,
      isComplete: (lessonId: string) => completed.has(lessonId),
      toggleComplete,
    }),
    [model, completed, toggleComplete],
  );

  return <CourseContext.Provider value={value}>{children}</CourseContext.Provider>;
}

export function useCourse(): CourseContextValue {
  const ctx = useContext(CourseContext);
  if (!ctx) throw new Error('useCourse must be used within a CourseProvider');
  return ctx;
}
