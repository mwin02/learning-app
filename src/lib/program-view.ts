// Phase 2.75e (learn UI): the read projection for the public PROGRAM hub — the
// goal-driven, multi-topic plan a learner sees at /programs/[id]. Analogous to
// getTrackView one level up: one shared, cached loader so the shell layout (program
// sidebar) and the main column render from a single query. The program hub lists the
// constituent Tracks (grouped by phase) and links into each Track's own /learn player;
// per-lesson progress lives inside those, not here.

import { cache } from 'react';
import type { ProgramStatus, PriorityTier } from '@prisma/client';
import { prisma } from '@/lib/db';

export type ProgramTrackView = {
  // The plan slot's canonical topic + presentation metadata.
  topic: string;
  phaseLabel: string;
  orderInProgram: number;
  priorityTier: PriorityTier;
  // The built Track (null until the child build fulfils — an unbuilt/failed slot).
  trackId: string | null;
  title: string | null;
  trackStatus: string | null;
  summary: string | null;
  lessonCount: number;
  totalMinutes: number;
  // Per-topic rationale (built Track goal, else the child request goal) + the child
  // request's live build state for slots not yet built.
  rationale: string | null;
  requestStatus: string | null;
  requestError: string | null;
};

export type ProgramPhaseView = { label: string; tracks: ProgramTrackView[] };

export type ProgramView = {
  id: string;
  // Phase 3d: goal/background/antiList are the creator's PRIVATE inputs; title/
  // description are the generated shareable surface (3c). Non-creator viewers get
  // a sanitized view (sanitizeProgramView below) where goal is replaced by the
  // title and the other private fields are blanked — components render `goal` as
  // the heading either way, so they need no viewer awareness.
  goal: string;
  title: string | null;
  description: string | null;
  createdById: string | null;
  background: string | null;
  totalHoursPerWeek: number;
  totalWeeks: number;
  antiList: string[];
  status: ProgramStatus;
  error: string | null;
  phases: ProgramPhaseView[];
  trackCount: number;
  builtCount: number;
  coreCount: number;
  totalLessons: number;
  totalMinutes: number;
};

// Phase 3d: the view handed to a NON-creator (an enrolled learner who didn't
// create the Program, or the unenrolled preview). Components render `goal` as the
// display heading, so the sanitized view substitutes the generated title and
// blanks the private inputs (background, antiList) and the internal failure
// diagnostic. Creators and admins see the raw view.
export function sanitizeProgramView(view: ProgramView): ProgramView {
  return {
    ...view,
    goal: view.title ?? 'Learning program',
    background: null,
    antiList: [],
    error: null,
    // Audit 6.2: per-slot requestError is the same class of raw worker
    // diagnostic as `error` (Prisma/Vertex internals) — blank it too.
    phases: view.phases.map((phase) => ({
      ...phase,
      tracks: phase.tracks.map((track) => ({ ...track, requestError: null })),
    })),
  };
}

// `cache()` dedupes within a single request (the layout + page both call this). It
// does NOT cache across requests — `dynamic = 'force-dynamic'` on the route keeps the
// program fresh as child Tracks finish building.
export const getProgramView = cache(async (programId: string): Promise<ProgramView | null> => {
  const program = await prisma.program.findUnique({
    where: { id: programId },
    select: {
      id: true,
      goal: true,
      title: true,
      description: true,
      userId: true,
      background: true,
      totalHoursPerWeek: true,
      totalWeeks: true,
      antiList: true,
      status: true,
      error: true,
      programPaths: {
        orderBy: { orderInProgram: 'asc' },
        select: {
          topic: true,
          phaseLabel: true,
          orderInProgram: true,
          priorityTier: true,
          trackId: true,
          track: {
            select: {
              title: true,
              status: true,
              summary: true,
              goal: true,
              lessons: { select: { estMinutes: true } },
            },
          },
        },
      },
      courseRequests: { select: { topic: true, status: true, goal: true, error: true } },
    },
  });
  if (!program) return null;

  const reqByTopic = new Map(program.courseRequests.map((r) => [r.topic, r]));

  const tracks: ProgramTrackView[] = program.programPaths.map((slot) => {
    const req = reqByTopic.get(slot.topic);
    const lessonCount = slot.track?.lessons.length ?? 0;
    const totalMinutes = slot.track?.lessons.reduce((sum, l) => sum + l.estMinutes, 0) ?? 0;
    return {
      topic: slot.topic,
      phaseLabel: slot.phaseLabel,
      orderInProgram: slot.orderInProgram,
      priorityTier: slot.priorityTier,
      trackId: slot.trackId,
      title: slot.track?.title ?? null,
      trackStatus: slot.track?.status ?? null,
      summary: slot.track?.summary ?? null,
      lessonCount,
      totalMinutes,
      rationale: slot.track?.goal ?? req?.goal ?? null,
      requestStatus: req?.status ?? null,
      requestError: req?.error ?? null,
    };
  });

  // Group into phases, preserving orderInProgram (first occurrence sets phase order).
  const phases: ProgramPhaseView[] = [];
  for (const t of tracks) {
    let phase = phases.find((p) => p.label === t.phaseLabel);
    if (!phase) {
      phase = { label: t.phaseLabel, tracks: [] };
      phases.push(phase);
    }
    phase.tracks.push(t);
  }

  return {
    id: program.id,
    goal: program.goal,
    title: program.title,
    description: program.description,
    createdById: program.userId,
    background: program.background,
    totalHoursPerWeek: program.totalHoursPerWeek,
    totalWeeks: program.totalWeeks,
    antiList: program.antiList,
    status: program.status,
    error: program.error,
    phases,
    trackCount: tracks.length,
    builtCount: tracks.filter((t) => t.trackId).length,
    coreCount: tracks.filter((t) => t.priorityTier === 'core').length,
    totalLessons: tracks.reduce((sum, t) => sum + t.lessonCount, 0),
    totalMinutes: tracks.reduce((sum, t) => sum + t.totalMinutes, 0),
  };
});

// Shared minute → "Xh Ym" / "Ym" label (mirrors the learn model's duration format).
export function formatMinutes(min: number): string {
  if (min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
