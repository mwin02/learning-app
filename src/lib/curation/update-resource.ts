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
// will pick it up. durationMin/difficulty/requiresPurchase/type don't feed the
// embedding — the staleness test below is an allowlist of the two fields
// buildEmbeddingText (ai/embeddings.ts) actually reads, so a new non-embedded
// field needs no change there.
//
// Q9 — provenance: a durationMin correction arriving here is a HUMAN measurement
// (both callers are reviewer surfaces: the PATCH route behind the review queue /
// review skill, and report triage's `edit` action), so it stamps
// `durationSource: 'reviewer'` alongside the number. Before Q9 the whitelist
// carried `durationMin` but not `durationSource`, so every hand-measured value
// landed still reading `unknown` — indistinguishable from a number nobody
// checked, which is the exact defect Q2 exists to remove. `durationSource` is
// deliberately NOT a caller-supplied field: the caller cannot assert a
// provenance other than "I measured it", so it is derived, not passed.
//
// S6 — clearing durationMin to null is a RETRACTION, not a measurement, so it
// stamps `unknown` ("nobody measured or estimated it") rather than `reviewer`. A
// cleared row stamped `reviewer` would be frozen permanently: the enum documents
// `reviewer` as the highest authority, which no automated pass may overwrite, so
// the row would read "a human measured this as nothing" forever and no
// re-measurement could reach it. A supplied number still stamps `reviewer`, and a
// `reviewer` row can still be cleared later.
//
// S6 — a `type` correction is refused on anything but an `atomic` row: on a
// container the label has already been acted on (children exist), so changing it
// is a re-decompose decision rather than an edit. resource-update-schema.ts
// carries the full reasoning and the re-decompose interaction callers inherit. A
// type edit takes no provenance stamp — there is no per-field provenance column
// outside duration, and a single-field one is not worth inventing here; the
// authorship of the edit lives in the review/report trail that produced it.

import type { Difficulty, ResourceStatus, DecompositionStatus, ResourceType, DurationSource } from '@prisma/client';
import { prisma } from '@/lib/db';
import { MAX_ATTACHABLE_DURATION_MIN } from '@/lib/config';
import { RETYPEABLE_TYPES } from '@/lib/api/resource-update-schema';

// Extract, not a bare literal union: if the Prisma enum ever loses one of these
// values this stops compiling instead of accepting a type the column can't hold.
type RetypeTarget = Extract<ResourceType, (typeof RETYPEABLE_TYPES)[number]>;

export type ResourceUpdateFields = {
  // null retracts the stored number ("nobody measured this") — see the header.
  durationMin?: number | null;
  title?: string;
  summary?: string;
  difficulty?: Difficulty;
  // Reports R4: the fix for a `paywalled` report. A wrong access flag is a field
  // defect like a wrong duration — deprecating a good resource over it throws the
  // resource away to correct a boolean.
  requiresPurchase?: boolean;
  // S6: standard clause 6 — the repair for a row whose recorded form is not what
  // the content is. Atomic rows only; see the header.
  type?: RetypeTarget;
};

export type UpdatedResource = {
  id: string;
  title: string;
  url: string;
  type: ResourceType;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
  durationMin: number | null;
  durationSource: DurationSource;
  difficulty: Difficulty;
  requiresPurchase: boolean;
};

export type ResourceUpdateResult =
  | { kind: 'not_found' }
  | { kind: 'refused'; reason: string }
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
  // Q2: an unknown duration can't be over the ceiling. selectAttachable passes it too.
  if (row.durationMin == null || row.durationMin <= MAX_ATTACHABLE_DURATION_MIN) return undefined;
  return `durationMin ${row.durationMin} is now over the attachable ceiling (${MAX_ATTACHABLE_DURATION_MIN}) on an atomic row — decompose or reject; do not approve.`;
}

export async function updateResource(
  resourceId: string,
  fields: ResourceUpdateFields,
): Promise<ResourceUpdateResult> {
  const existing = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true, decompositionStatus: true },
  });
  if (!existing) return { kind: 'not_found' };

  if (fields.type !== undefined && existing.decompositionStatus !== 'atomic') {
    return {
      kind: 'refused',
      reason: `type is editable on atomic rows only; this row is ${existing.decompositionStatus} — re-type it through decomposition review (action: 'decompose'), not an edit.`,
    };
  }

  const resource = await prisma.resource.update({
    where: { id: resourceId },
    data:
      fields.durationMin !== undefined
        ? {
            ...fields,
            durationSource: fields.durationMin === null ? ('unknown' as const) : ('reviewer' as const),
          }
        : fields,
    select: {
      id: true,
      title: true,
      url: true,
      type: true,
      status: true,
      decompositionStatus: true,
      durationMin: true,
      durationSource: true,
      difficulty: true,
      requiresPurchase: true,
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
