// Q9 — the pending-review queue's provenance rendering, as pure functions.
//
// The queue is the last gate a resource passes, and a reviewer working it has the
// rendered page open — the one context where the true duration and the true topic
// are free. That only helps if the reviewer can see WHICH of the row's numbers
// nobody verified, so these derive one short label per provenance axis plus the
// `unverified` flag the page uses to draw attention to it.
//
// Deliberately not a gate: `unverified` is styling and a nudge, never a block. An
// interactive with no measurable signal (a Khan `/pi/` widget) stays approvable —
// blocking on `unknown` would make it a permanent queue resident.

import type { DurationSource } from '@prisma/client';
import type { FilingProvenance } from '@/lib/curation/pending-review';

// The sources that mean "somebody or something actually measured this". `estimated`
// is a calibrated guess and `unknown` is nothing at all, so both read as unverified.
const VERIFIED_DURATION: DurationSource[] = ['api', 'extracted', 'reviewer'];

export type ProvenanceLabel = {
  text: string;
  unverified: boolean;
};

export function durationLabel(
  durationMin: number | null,
  durationSource: DurationSource,
): ProvenanceLabel {
  const value = durationMin === null ? 'no duration' : `${durationMin}m`;
  return {
    text: `${value} · ${durationSource}`,
    unverified: !VERIFIED_DURATION.includes(durationSource),
  };
}

// The filing origins nothing measured: `inherited` is the T1 backfill placeholder
// (a label copied off the legacy scalar) and `discovery` is the searched topic
// asserting its own relevance — the signal the whole filing plan exists to distrust.
// A contested membership is a measurement that came out ambiguous, which the
// reviewer is equally the right person to settle.
const UNMEASURED_FILING: FilingProvenance['origin'][] = ['inherited', 'discovery'];

export function filingLabel(filing: FilingProvenance | null): ProvenanceLabel {
  // Worse than unmeasured: the row is unreachable by topic retrieval at all.
  if (!filing) return { text: 'no primary topic membership', unverified: true };
  const parts = [filing.topic, filing.origin, `rel ${filing.relevance.toFixed(2)}`];
  if (filing.contested) parts.push('contested');
  return {
    text: parts.join(' · '),
    unverified: UNMEASURED_FILING.includes(filing.origin) || filing.contested,
  };
}
