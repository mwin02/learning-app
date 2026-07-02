// Phase 2.75e (learn UI): shared presentational helpers for the public program hub.
// Token-only (no raw hex/px) so the pages flip with the design system + dark mode.
import type { ProgramStatus } from '@prisma/client';
import type { ProgramTrackView } from '@/lib/program-view';

// A track slot's coarse build state, derived from the built Track's status (if any)
// else the child request's status. Drives the row dot + badge.
export type TrackBuildState = 'ready' | 'building' | 'failed';

export function trackBuildState(t: ProgramTrackView): TrackBuildState {
  if (t.trackId && t.trackStatus === 'ready') return 'ready';
  if (t.requestStatus === 'failed' || t.trackStatus === 'failed') return 'failed';
  return 'building';
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
