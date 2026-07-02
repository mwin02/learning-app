import type { ProgramStatus } from '@prisma/client';

// Shared status → badge classes for the Program playground pages. Mirrors the
// ad-hoc TRACK_STATUS_STYLE map on the track viewer (playground predates the
// centralized design tokens — see CLAUDE.md styling scope note).
export const PROGRAM_STATUS_STYLE: Record<ProgramStatus, string> = {
  planning: 'bg-gray-100 text-gray-700',
  building: 'bg-amber-100 text-amber-800',
  ready: 'bg-green-100 text-green-800',
  partial: 'bg-blue-100 text-blue-800',
  failed: 'bg-red-100 text-red-800',
};

// Priority tier badge: core is emphasized (it's what the goal actually requires),
// nice_to_have is muted (the first thing a tight budget cuts).
export const TIER_STYLE: Record<string, string> = {
  core: 'bg-indigo-600 text-white',
  nice_to_have: 'bg-gray-100 text-gray-500',
};
