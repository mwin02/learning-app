// Library re-judge Block 1 — derive ResourceSourcedFor provenance pairs from a
// sourcing run's upsert outcomes. Pure (no DB) so the logic is unit-testable;
// web-fallback's persistence tail feeds it and writes the result via
// `createMany … skipDuplicates`.
//
// A pair records "this concept's demand caused this resource to be sourced but
// NOT attached in the same run". There are two ways to be unattached:
//
//   - the row parked non-atomic (pending / human_review / unsupported /
//     decomposed container) — its pickable rows appear only after decomposition
//     review, and rejudge-sourced-for offers them back then;
//   - the row is atomic but QUARANTINED by validation (a liveness check suspected
//     a soft-404 but wasn't trusted enough to delete it). It is held out of the
//     attach set and left in pending_review, so the same hook offers it back if a
//     reviewer approves it.
//
// Everything else atomic lands in insertedIds and is judged+attached by the
// caller, so it needs no provenance. Both freshly-inserted and dedup-hit rows
// qualify: a rediscovery of an existing parked row is a real second demand signal
// (and skipDuplicates makes re-demand under the SAME concept a no-op, not an
// error). A caller with no concept (no conceptId) derives nothing.

import type { DecompositionStatus } from '@prisma/client';

// One survivor's upsert outcome, as seen by the persistence tail. `resourceId`
// is null when the upsert produced no addressable parent row (transaction
// failure) — nothing to record.
export type SourcedForRow = {
  resourceId: string | null;
  decompositionStatus: DecompositionStatus | null;
  // Held out of the attach set by a quarantine verdict, so an atomic row still
  // needs provenance — it is unattached for a different reason than parking.
  quarantined?: boolean;
};

export function deriveSourcedForPairs(
  conceptId: string | null | undefined,
  rows: SourcedForRow[],
): { resourceId: string; conceptId: string }[] {
  if (!conceptId) return [];
  const seen = new Set<string>();
  const pairs: { resourceId: string; conceptId: string }[] = [];
  for (const row of rows) {
    if (!row.resourceId || !row.decompositionStatus) continue;
    if (row.decompositionStatus === 'atomic' && !row.quarantined) continue;
    if (seen.has(row.resourceId)) continue;
    seen.add(row.resourceId);
    pairs.push({ resourceId: row.resourceId, conceptId });
  }
  return pairs;
}
