// Phase 2.6 (learn UI): the read projection for the public course player. One
// shared loader so the shell layout (sidebar syllabus) and the per-lesson content
// pane render from the same query — wrapped in React `cache()` so a layout + page
// in the same request hit the DB once. Mirrors the playground track view's select
// (src/app/playground/tracks/[trackId]/page.tsx) but is a stable, typed contract
// the public route depends on.

import { cache } from 'react';
import { prisma } from '@/lib/db';

export type TrackResourceView = {
  // LessonResource id — the stable key the player uses for per-resource UI state.
  id: string;
  role: string;
  deliveryMode: string;
  segmentRef: unknown;
  resource: { id: string; title: string; url: string; type: string };
};

export type TrackLessonView = {
  id: string;
  orderInTrack: number;
  sectionId: string | null;
  title: string;
  summary: string;
  conceptsTaught: string[];
  estMinutes: number;
  resources: TrackResourceView[];
};

export type TrackSectionView = {
  id: string;
  orderInTrack: number;
  title: string;
  intro: string | null;
};

export type TrackView = {
  id: string;
  status: string;
  title: string | null;
  summary: string | null;
  targetMastery: string | null;
  intent: string | null;
  topic: string;
  pathId: string;
  totalMinutes: number;
  sections: TrackSectionView[];
  lessons: TrackLessonView[];
};

// `cache()` dedupes within a single request (the shell layout + the lesson page
// both call this). It does NOT cache across requests — `dynamic = 'force-dynamic'`
// on the route keeps the data fresh as Tracks/progress change.
export const getTrackView = cache(async (trackId: string): Promise<TrackView | null> => {
  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: {
      id: true,
      status: true,
      title: true,
      summary: true,
      targetMastery: true,
      intent: true,
      path: { select: { id: true, topic: true } },
      sections: {
        orderBy: { orderInTrack: 'asc' },
        select: { id: true, orderInTrack: true, title: true, intro: true },
      },
      lessons: {
        orderBy: { orderInTrack: 'asc' },
        select: {
          id: true,
          orderInTrack: true,
          sectionId: true,
          title: true,
          summary: true,
          conceptsTaught: true,
          estMinutes: true,
          resources: {
            orderBy: { orderInLesson: 'asc' },
            select: {
              id: true,
              role: true,
              deliveryMode: true,
              segmentRef: true,
              resource: { select: { id: true, title: true, url: true, type: true } },
            },
          },
        },
      },
    },
  });
  if (!track) return null;

  return {
    id: track.id,
    status: track.status,
    title: track.title,
    summary: track.summary,
    targetMastery: track.targetMastery,
    intent: track.intent,
    topic: track.path.topic,
    pathId: track.path.id,
    totalMinutes: track.lessons.reduce((sum, l) => sum + l.estMinutes, 0),
    sections: track.sections,
    lessons: track.lessons.map((l) => ({
      ...l,
      resources: l.resources.map((r) => ({
        id: r.id,
        role: r.role,
        deliveryMode: r.deliveryMode,
        segmentRef: r.segmentRef,
        resource: r.resource,
      })),
    })),
  };
});
