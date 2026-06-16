// Phase 2.5d-3: spine-readiness policy — pure, so it unit-tests without a DB.
//
// A Path gates the first Track only when its spine is *teachable*: every spine
// concept must have at least one `teaches` candidate clearing the coverage floor
// (MAP_SPINE_MIN_PRIMARY_COVERAGE). A concept with only `uses`/`assesses`
// candidates — or only weak `teaches` — has no valid Lesson primary, so it's a
// spine hole and the Path is NOT ready. This upgrades 2.5d-2's coarse
// `candidates.length === 0` hole signal to "no qualifying primary", which the
// dom-manipulation case (a lone `uses 0.5`) showed was necessary.

import { ConceptResourceRole } from '@prisma/client';
import { MAP_SPINE_MIN_PRIMARY_COVERAGE } from '@/lib/config';
import type { ConceptAttachment } from '@/lib/agents/map/attach-candidates';

export type ReadinessResult = {
  // True when every concept has a qualifying `teaches` primary.
  ready: boolean;
  // Slugs of concepts lacking a qualifying primary (the spine holes). Empty when ready.
  holes: string[];
};

// Does this attachment have a `teaches` candidate at or above the coverage floor?
export function hasQualifyingPrimary(attachment: ConceptAttachment): boolean {
  return attachment.candidates.some(
    (c) =>
      c.role === ConceptResourceRole.teaches &&
      c.coverageScore >= MAP_SPINE_MIN_PRIMARY_COVERAGE,
  );
}

// Is this concept covered for readiness purposes? Either it has a qualifying
// primary, or remediation relaxed the bar (2.5f) and there is some candidate to
// stand in as a best-effort primary. A relaxed concept with NO candidate is still
// a hole — relaxing can't conjure a resource (that path escalates instead).
function isCovered(attachment: ConceptAttachment): boolean {
  if (hasQualifyingPrimary(attachment)) return true;
  return Boolean(attachment.primaryRelaxed) && attachment.candidates.length > 0;
}

// Compute readiness over all spine concepts' attachments. An empty spine is not
// ready — a Path with no concepts can't gate a coherent Track.
export function computeReadiness(attachments: ConceptAttachment[]): ReadinessResult {
  if (attachments.length === 0) return { ready: false, holes: [] };
  const holes = attachments
    .filter((a) => !isCovered(a))
    .map((a) => a.conceptSlug);
  return { ready: holes.length === 0, holes };
}
