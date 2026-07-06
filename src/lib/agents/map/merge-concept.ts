// Pre-Freeze Map Review (Block 3) — the PURE merge planner.
//
// When an operator confirms a `duplication` finding, one concept (the loser) is
// merged into the other (the winner): the loser's resource links + prerequisite
// edges repoint onto the winner, then the loser is deleted. This module computes
// WHAT to change, deterministically, so the DB sink (path-review.ts applyConceptMerge)
// is a thin apply and the interesting logic unit-tests without a DB.
//
// Three jobs, all conservative because the target is a permanent, frozen artifact:
//   - resource links: move the loser links whose resource the winner doesn't
//     already have; the duplicates just die with the loser (cascade).
//   - edges: repoint each loser edge onto the winner, DROPPING the collapsed
//     winner↔loser self-loop and any edge the winner already has.
//   - cycle guard: report whether the post-merge DAG would contain a cycle, so the
//     sink can ABORT rather than silently corrupt the invariant. (Two duplicate
//     concepts with a prerequisite path between them is pathological but not
//     impossible; aborting is safe, silent corruption is not.)

import { findCycle } from '@/lib/agents/map/cycle';

// Thrown by the merge sink when the planned merge would introduce a prerequisite
// cycle. The route maps it to a 422 and nothing is written (the tx rolls back).
export class MergeCycleError extends Error {
  constructor(winnerId: string, loserId: string) {
    super(`Merging ${loserId} into ${winnerId} would create a prerequisite cycle`);
    this.name = 'MergeCycleError';
  }
}

export type MergeEdge = { fromConceptId: string; toConceptId: string };

export type ConceptMergePlan = {
  // Loser ConceptResource row ids to repoint onto the winner (their resource is
  // not already linked to the winner). The rest are duplicates left to cascade.
  resourceLinkIdsToMove: string[];
  // New winner-anchored prerequisite edges to create (self-loops + existing edges
  // already excluded).
  edgesToCreate: MergeEdge[];
  // True if creating edgesToCreate would introduce a prerequisite cycle — the sink
  // must not apply the merge.
  wouldCycle: boolean;
};

export function planConceptMerge(args: {
  winnerId: string;
  loserId: string;
  // Every prerequisite edge in the Path (concept ids).
  edges: MergeEdge[];
  // The resource ids already linked to the winner.
  winnerResourceIds: Set<string>;
  // The loser's ConceptResource rows (id + which resource).
  loserResourceLinks: { id: string; resourceId: string }[];
}): ConceptMergePlan {
  const { winnerId, loserId, edges, winnerResourceIds, loserResourceLinks } = args;

  const resourceLinkIdsToMove = loserResourceLinks
    .filter((l) => !winnerResourceIds.has(l.resourceId))
    .map((l) => l.id);

  // Edges that survive the loser's deletion (they don't touch it), keyed for dedupe.
  const survivingEdges = edges.filter(
    (e) => e.fromConceptId !== loserId && e.toConceptId !== loserId,
  );
  const present = new Set(survivingEdges.map(edgeKey));

  const edgesToCreate: MergeEdge[] = [];
  const created = new Set<string>();
  for (const e of edges) {
    if (e.fromConceptId !== loserId && e.toConceptId !== loserId) continue; // not a loser edge
    const from = e.fromConceptId === loserId ? winnerId : e.fromConceptId;
    const to = e.toConceptId === loserId ? winnerId : e.toConceptId;
    if (from === to) continue; // the collapsed winner↔loser edge → self-loop, drop
    const key = edgeKey({ fromConceptId: from, toConceptId: to });
    if (present.has(key) || created.has(key)) continue; // winner already has it / dupe
    created.add(key);
    edgesToCreate.push({ fromConceptId: from, toConceptId: to });
  }

  // Post-merge adjacency = surviving edges + the new ones. If it has a cycle, the
  // merge is unsafe.
  const adjacency = new Map<string, string[]>();
  const add = (f: string, t: string) => {
    if (!adjacency.has(f)) adjacency.set(f, []);
    if (!adjacency.has(t)) adjacency.set(t, []);
    adjacency.get(f)!.push(t);
  };
  for (const e of [...survivingEdges, ...edgesToCreate]) add(e.fromConceptId, e.toConceptId);
  const wouldCycle = findCycle(adjacency) !== null;

  return { resourceLinkIdsToMove, edgesToCreate, wouldCycle };
}

function edgeKey(e: MergeEdge): string {
  return `${e.fromConceptId}>${e.toConceptId}`;
}
