// Phase 2.5f-3a: the hole-legitimacy classifier — pure, so it tests without a DB.
//
// A spine hole (a concept with no `teaches` candidate at/above
// MAP_SPINE_MIN_PRIMARY_COVERAGE) is remediated two different ways, and the right
// one is read from the hole's own candidate-coverage evidence:
//
//   gap        — no qualifying primary because no good-enough resource EXISTS yet.
//                Fix by SOURCING a better resource (relax the bar on exhaustion).
//                Examples: zero `teaches` at all (ML unsupervised-learning); a lone
//                sub-floor `teaches`; several sub-floor `teaches` that all cover the
//                SAME slice (more of the same wouldn't get us over the floor, but
//                splitting finer wouldn't either — a better resource would).
//
//   conflation — no qualifying primary because the concept is too COARSE: several
//                sub-floor `teaches` each cover a DIFFERENT slice and none spans the
//                whole concept. Fix by SPLITTING the concept into finer nodes +
//                re-attaching (2.5f-4), NOT by sourcing. The linear-algebra
//                "Linear Independence, Basis, and Dimension" case.
//
// This is the reliable backstop for the 2.5d granularity reviewer, which is
// title-based and not guaranteed to catch a plausible-looking coarse bundle.

import { ConceptResourceRole } from '@prisma/client';
import {
  MAP_SPINE_MIN_PRIMARY_COVERAGE,
  REMEDIATION_CONFLATION_BAND_MIN,
  REMEDIATION_CONFLATION_MIN_TEACHES,
  REMEDIATION_CONFLATION_SLICE_SIMILARITY,
} from '@/lib/config';

// One candidate's evidence: its role, how well it covers the concept, and what it
// teaches (the slice signal — drawn from the underlying Resource.conceptsTaught).
export type HoleCandidate = {
  resourceId: string;
  role: ConceptResourceRole;
  coverageScore: number;
  conceptsTaught: string[];
};

export type HoleClassification =
  | { kind: 'gap'; reason: string }
  // `slices` = the number of distinct slices the sub-floor `teaches` cover; the
  // splitter (2.5f-4) uses it as a hint for how finely to decompose.
  | { kind: 'conflation'; reason: string; slices: number };

// Classify a spine hole from its candidates. Caller passes a concept that is
// genuinely a hole (no `teaches` >= floor); a qualifying primary present is
// treated as a gap defensively (it isn't a hole and shouldn't have been passed).
export function classifyHole(candidates: HoleCandidate[]): HoleClassification {
  // Sub-floor `teaches` in the evidence band — the only candidates that can signal
  // conflation. Below BAND_MIN is search noise; `uses`/`assesses` never teach.
  const subFloorTeaches = candidates.filter(
    (c) =>
      c.role === ConceptResourceRole.teaches &&
      c.coverageScore >= REMEDIATION_CONFLATION_BAND_MIN &&
      c.coverageScore < MAP_SPINE_MIN_PRIMARY_COVERAGE,
  );

  if (subFloorTeaches.length < REMEDIATION_CONFLATION_MIN_TEACHES) {
    return { kind: 'gap', reason: `${subFloorTeaches.length} sub-floor teaches (< ${REMEDIATION_CONFLATION_MIN_TEACHES}); needs a better resource` };
  }

  const slices = distinctSliceCount(subFloorTeaches);
  if (slices < 2) {
    return { kind: 'gap', reason: `${subFloorTeaches.length} sub-floor teaches but only ${slices} distinct slice; same coverage, needs a better resource` };
  }

  return { kind: 'conflation', reason: `${subFloorTeaches.length} sub-floor teaches across ${slices} distinct slices; concept is too coarse`, slices };
}

// Greedily cluster candidates by conceptsTaught overlap: a candidate joins an
// existing cluster when its tags are "the same slice" (Jaccard >= threshold) as
// that cluster's first member, else it seeds a new cluster. The cluster count is
// the number of distinct slices. Greedy (not exhaustive) is enough — we only need
// to distinguish "all one slice" from "genuinely several".
function distinctSliceCount(candidates: HoleCandidate[]): number {
  const reps: Set<string>[] = [];
  for (const c of candidates) {
    const tags = new Set(c.conceptsTaught.map((t) => t.toLowerCase().trim()).filter(Boolean));
    const matched = reps.some((rep) => jaccard(rep, tags) >= REMEDIATION_CONFLATION_SLICE_SIMILARITY);
    if (!matched) reps.push(tags);
  }
  return reps.length;
}

// Jaccard similarity of two tag sets: |∩| / |∪|. Two empty sets are treated as
// identical (similarity 1) so untagged candidates collapse to one slice rather
// than each counting as distinct — untagged is not evidence of coarseness.
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
