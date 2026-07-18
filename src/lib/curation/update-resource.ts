// Resource metadata correction — the *edit* axis of curation, alongside the
// approval axis (pending-review.ts) and the shape axis (decomposition). Applies
// a whitelisted field update to any Resource row regardless of status: the
// review-pending-resources skill corrects pending rows mid-review, and the
// cleanup/audit block reuses it on active ones. Deliberately does NOT touch
// lifecycle state (status / decompositionStatus) — an update that reveals a
// problem (e.g. a corrected duration over the attach ceiling) is *surfaced* via
// `warning` for the caller to act on through the proper lifecycle APIs, never
// auto-parked here.
//
// Side-effect surfacing: title/summary edits bump updatedAt, which makes the
// stored embedding stale (embeddedAt < updatedAt → the backfill re-embeds; the
// embedding covers title + summary + conceptsTaught). No extra work needed —
// the result just flags `embeddingStale: true` so the caller knows the backfill
// will pick it up. durationMin/difficulty don't feed the embedding.

import type { Difficulty, ResourceStatus, DecompositionStatus, ResourceType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { MAX_ATTACHABLE_DURATION_MIN } from '@/lib/config';

export type ResourceUpdateFields = {
  durationMin?: number;
  title?: string;
  summary?: string;
  difficulty?: Difficulty;
};

export type UpdatedResource = {
  id: string;
  title: string;
  url: string;
  type: ResourceType;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
  durationMin: number;
  difficulty: Difficulty;
};

export type ResourceUpdateResult =
  | { kind: 'not_found' }
  | {
      kind: 'updated';
      resource: UpdatedResource;
      changed: (keyof ResourceUpdateFields)[];
      embeddingStale: boolean;
      warning?: string;
    };

// Post-state check, not a gate: fires whenever the update *leaves* an atomic row
// over the attach ceiling (selectAttachable would drop it), regardless of which
// field changed. Containers are exempt — they're never directly attachable and
// their duration legitimately sums their children.
function ceilingWarning(row: UpdatedResource): string | undefined {
  if (row.decompositionStatus !== 'atomic') return undefined;
  if (row.durationMin <= MAX_ATTACHABLE_DURATION_MIN) return undefined;
  return `durationMin ${row.durationMin} is now over the attachable ceiling (${MAX_ATTACHABLE_DURATION_MIN}) on an atomic row — decompose or reject; do not approve.`;
}

export async function updateResource(
  resourceId: string,
  fields: ResourceUpdateFields,
): Promise<ResourceUpdateResult> {
  const existing = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true },
  });
  if (!existing) return { kind: 'not_found' };

  const resource = await prisma.resource.update({
    where: { id: resourceId },
    data: fields,
    select: {
      id: true,
      title: true,
      url: true,
      type: true,
      status: true,
      decompositionStatus: true,
      durationMin: true,
      difficulty: true,
    },
  });

  const changed = Object.keys(fields) as (keyof ResourceUpdateFields)[];
  const result: ResourceUpdateResult = {
    kind: 'updated',
    resource,
    changed,
    embeddingStale: changed.includes('title') || changed.includes('summary'),
  };
  const warning = ceilingWarning(resource);
  if (warning) result.warning = warning;
  return result;
}
