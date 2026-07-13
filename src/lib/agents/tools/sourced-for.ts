// Library re-judge Block 1 — derive ResourceSourcedFor provenance pairs from a
// sourcing run's upsert outcomes. Pure (no DB) so the logic is unit-testable;
// web-fallback's persistence tail feeds it and writes the result via
// `createMany … skipDuplicates`.
//
// A pair records "this concept's demand caused this resource to be sourced but
// NOT attached in the same run". So a row is eligible only when it parked
// non-atomic (pending / human_review / unsupported / decomposed container) —
// atomic rows land in insertedIds and are judged+attached by the caller, no
// provenance needed. Both freshly-inserted and dedup-hit rows qualify: a
// rediscovery of an existing parked row is a real second demand signal (and
// skipDuplicates makes re-demand under the SAME concept a no-op, not an error).
// The topic-level entry point has no concept and derives nothing.

import type { DecompositionStatus } from '@prisma/client';

// One survivor's upsert outcome, as seen by the persistence tail. `resourceId`
// is null when the upsert produced no addressable parent row (transaction
// failure) — nothing to record.
export type SourcedForRow = {
  resourceId: string | null;
  decompositionStatus: DecompositionStatus | null;
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
    if (row.decompositionStatus === 'atomic') continue;
    if (seen.has(row.resourceId)) continue;
    seen.add(row.resourceId);
    pairs.push({ resourceId: row.resourceId, conceptId });
  }
  return pairs;
}
