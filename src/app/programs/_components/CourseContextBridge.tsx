'use client';

// Frontend redesign Block 3: adapts the program-wide progress provider to the
// course player's CourseContext, so the existing player components (CourseHome,
// LessonView, ContinueLearningCard) run unchanged inside the program shell —
// and their toggles update the shell's rail live. The [trackId] layout renders
// this instead of the standalone CourseProvider.

import { useMemo } from 'react';
import type { TrackView } from '@/lib/track-view';
import { buildCourseHomeModel } from '@/lib/course-home-model';
import { CourseContext, type CourseContextValue } from '@/app/learn/_components/course-context';
import { useProgramProgress } from './ProgramShell';

export function CourseContextBridge({
  track,
  basePath,
  children,
}: {
  track: TrackView;
  basePath: string;
  children: React.ReactNode;
}) {
  const { completed, toggle } = useProgramProgress();

  // The global completed set works directly: lesson ids are unique, and the
  // model builder only tests membership.
  const model = useMemo(() => buildCourseHomeModel(track, completed), [track, completed]);

  const value = useMemo<CourseContextValue>(
    () => ({
      model,
      basePath,
      isComplete: (lessonId: string) => completed.has(lessonId),
      toggleComplete: (lessonId: string) => toggle(track.id, lessonId),
    }),
    [model, basePath, completed, toggle, track.id]
  );

  return <CourseContext.Provider value={value}>{children}</CourseContext.Provider>;
}
