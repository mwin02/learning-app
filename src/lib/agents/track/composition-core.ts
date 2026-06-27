// Phase 2.5e-8 (Block 2a): the pure, LLM-free enforcement primitives of the Track
// composer, extracted from validate-composition.ts so the SAME logic can back two
// callers without drifting:
//   - validate-composition.ts — the post-hoc critic over a finished composition.
//   - the composer AGENT's incremental build tools (Block 2b) — which must give the
//     model LIVE feedback ("you haven't placed concept X's prerequisite") that
//     exactly matches what the final validation will enforce. One source of truth.
//
// Nothing here knows about the LLM, resources, or the budget. It is graph + grouping
// logic only:
//   - buildPrereqIndex:        edge list → per-concept direct-prerequisite map.
//   - computeInclusion:        downward-closure of a seed set over non-excluded prereqs.
//   - assignConceptsToLessons: included concepts → one lesson each (honor groupings,
//                              synthesize singletons for anything left over).
//   - orderConceptSlugs:       continuity-first DAG order with a branch-point tie-break.
//
// This is a behavior-preserving extraction (Block 2a): validate-composition.ts calls
// these and is byte-for-byte equivalent to its inline predecessor (see verify-composer).

import { continuityOrder, type OrderEdge } from '@/lib/agents/map/order';
import type { TimeWeight } from '@/lib/agents/track/allocate';

// One lesson as a grouping of concepts, carrying the composer's graded resource lists
// through untouched (resource resolution is the caller's job). Used as both the input
// (a composed/agent-built lesson is structurally a superset of this) and the output of
// assignConceptsToLessons.
export type LessonGroup = {
  conceptSlugs: string[];
  title: string;
  summary: string;
  masteryRelevant: boolean;
  timeWeight: TimeWeight;
  // The composer's graded lists ([] for a synthesized lesson → caller's fallback resolves).
  mandatoryResourceIds: string[];
  optionalResourceIds: string[];
};

// Per-concept direct-prerequisite map. Every slug gets an entry (possibly empty), and
// edges referencing a slug not in `slugs` are ignored — so the keys define the valid
// concept universe for computeInclusion.
export function buildPrereqIndex(slugs: Iterable<string>, edges: OrderEdge[]): Map<string, string[]> {
  const prereqsOf = new Map<string, string[]>();
  for (const s of slugs) prereqsOf.set(s, []);
  for (const e of edges) {
    if (prereqsOf.has(e.fromSlug) && prereqsOf.has(e.toSlug)) {
      prereqsOf.get(e.toSlug)!.push(e.fromSlug);
    }
  }
  return prereqsOf;
}

// Downward-closure: start from `seeds` and pull in every non-excluded prerequisite,
// transitively, so nothing included is left depending on an excluded concept. An
// excluded (pruned/omitted) concept is never re-added and stops the walk — its
// dependents' prereq is considered satisfied by exclusion. `prereqsOf`'s keys are the
// valid concept universe; an unknown seed is skipped.
export function computeInclusion(args: {
  prereqsOf: Map<string, string[]>;
  excluded: ReadonlySet<string>;
  seeds: Iterable<string>;
}): Set<string> {
  const { prereqsOf, excluded, seeds } = args;
  const included = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (included.has(s) || excluded.has(s) || !prereqsOf.has(s)) continue;
    included.add(s);
    for (const p of prereqsOf.get(s) ?? []) if (!included.has(p) && !excluded.has(p)) stack.push(p);
  }
  return included;
}

// Assign each included concept to exactly one lesson: honor the proposed groupings
// (dropping references to excluded/unknown/already-assigned concepts and skipping a
// lesson that empties out), then sweep any included concept no lesson placed into its
// own single-concept lesson so nothing included is silently lost. Appends a warning per
// synthesized concept. `concepts` supplies the title for a synthesized lesson and fixes
// the deterministic sweep order.
export function assignConceptsToLessons(args: {
  lessons: readonly LessonGroup[];
  included: ReadonlySet<string>;
  concepts: readonly { slug: string; title: string }[];
  warnings: string[];
}): LessonGroup[] {
  const { lessons, included, concepts, warnings } = args;
  const assigned = new Set<string>();
  const groups: LessonGroup[] = [];

  for (const l of lessons) {
    const slugs = l.conceptSlugs.filter((s) => included.has(s) && !assigned.has(s));
    if (slugs.length === 0) continue; // wholly excluded/duplicate/unknown lesson
    slugs.forEach((s) => assigned.add(s));
    groups.push({
      conceptSlugs: slugs,
      title: l.title,
      summary: l.summary,
      masteryRelevant: l.masteryRelevant,
      timeWeight: l.timeWeight,
      mandatoryResourceIds: l.mandatoryResourceIds,
      optionalResourceIds: l.optionalResourceIds,
    });
  }

  for (const c of concepts) {
    if (!included.has(c.slug) || assigned.has(c.slug)) continue;
    assigned.add(c.slug);
    warnings.push(`composer omitted included concept '${c.slug}'; synthesized a lesson for it`);
    groups.push({
      conceptSlugs: [c.slug],
      title: c.title,
      summary: `Learn ${c.title}.`,
      masteryRelevant: false,
      timeWeight: 'normal',
      mandatoryResourceIds: [],
      optionalResourceIds: [],
    });
  }

  return groups;
}

// Continuity-first DAG order over the included concepts: keeps each topic thread
// contiguous and never places a concept before a prerequisite, with `priority` breaking
// ties only at branch points (independent threads both ready). Edges touching an
// excluded concept are filtered out so the order reflects only what's included.
export function orderConceptSlugs(
  includedSlugs: string[],
  edges: OrderEdge[],
  priority?: ReadonlyMap<string, number>,
): string[] {
  const included = new Set(includedSlugs);
  return continuityOrder(
    includedSlugs.map((slug) => ({ slug })),
    edges.filter((e) => included.has(e.fromSlug) && included.has(e.toSlug)),
    priority,
  );
}
