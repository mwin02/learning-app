// The contested-membership review drain — grouping and prioritization (read side).
//
// T1–T4e left one gap the plan states plainly: nothing converts "this `calculus` row is
// really `precalculus`" into a RETRIEVABLE membership without a human. The reclassifier
// never refiles (As-built T4a item 5), so a disagreement lands as a contested secondary,
// which T1's retrieval predicate excludes by design. T4b's quorum refile is the only
// shipped mechanism that ever produced retrievable cross-topic reach, and it fires only
// on unvouchable shelves. So the queue only grows. This module is the read half of the
// drain that empties it: it decides what a reviewer is shown and in what order.
//
// ⚠️ THE INSTRUMENT THAT CREATED THIS QUEUE CANNOT DRAIN IT. Every row here is one k-NN
// already ruled on; re-running it just reproduces the doubt. Worse, the cfml retirement
// measured k-NN as actively CIRCULAR on the cases most in need of review — a large
// mis-filed shelf is its own neighbourhood and vouches for itself (see the header of
// shelf-retire.ts). That is why the queue is grouped by CONTAINER and why the caller
// gathers provenance (container title/topic, sibling filings, source) alongside the
// embedding evidence: provenance is the independent signal, and the rubric leans on it
// exactly where the neighbourhood is self-referential.

// One contested membership, joined to enough of its resource to be grouped and ranked.
export type DrainRow = {
  membershipId: string;
  resourceId: string;
  title: string;
  // The contested membership's topic. For a primary this is also `Resource.topic`.
  topic: string;
  // False for a contested SECONDARY. The two are different bugs and the rubric treats
  // them differently: a contested primary stays retrievable, so it is a labelling doubt;
  // a contested secondary is excluded from retrieval entirely, so it is a reachability
  // bug. Both are drained here — there are only 11 secondaries — but tagged.
  isPrimary: boolean;
  // Measured k-NN purity for this membership. Post-T4e every membership in the library
  // carries a real one, which is what makes it usable as the fallback sort key below.
  relevance: number;
  origin: string;
  // Null for a top-level row. Walked to find the container whose verdict can settle it.
  parentId: string | null;
  // Own-centroid similarity minus the best rival's, from `centroidMargins`. NULL is
  // common and load-bearing — see `queuePriority`.
  margin: number | null;
};

// A container's worth of queue. `rootId` is the top of the shared parent chain — which
// for a row with no parent is the row itself, so a loose row forms a group of one and a
// contested CONTAINER groups together with its contested children rather than splitting
// off into a separate bucket. Measured 2026-07-27: 5 of the top-level contested rows are
// themselves containers whose children are also queued, and those must present as one
// decision, not two.
export type DrainGroup = {
  rootId: string;
  rows: DrainRow[];
  // The group's own priority: its most-urgent row. Keeps a container intact in the
  // ordering without letting a big group of settled-looking rows outrank a single
  // badly-filed one.
  priority: readonly [number, number];
};

// Walks to the ROOT of the parent chain — the top-level container that owns this row's
// provenance. Copied from `containerOf` in shelf-retire.ts (cycle guard included) rather
// than shared: that function walks up to a member of a caller-supplied slate, which is
// the shape D2's verdict attribution needs but not this one. Here there is no slate yet
// — the grouping is what LETS a reviewer issue a container verdict — so the walk target
// is simply the top of the chain. A shared helper for twelve lines with two different
// stop conditions would be worse than the duplication.
//
// Returns null for a top-level row (nothing above it), and stops at a missing parent so a
// subtree whose root is outside the loaded set groups under the highest row we do have.
export type ParentLink = { parentId: string | null };

export function rootContainerOf(
  row: Pick<DrainRow, 'resourceId' | 'parentId'>,
  byId: Map<string, ParentLink>,
): string | null {
  if (!row.parentId) return null;
  let cursor = row.parentId;
  const seen = new Set<string>([row.resourceId]);
  for (;;) {
    // A malformed parent chain must not hang the pass.
    if (seen.has(cursor)) return cursor;
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent?.parentId) return cursor;
    cursor = parent.parentId;
  }
}

// ⚠️ THE MARGIN ALONE IS NOT A USABLE SORT KEY, and this is the block's one real
// measurement. The plan demotes the centroid margin to exactly one job — review-priority
// ranking, lowest first (As-built T4a item 6, confirmed T4e item 4). But `centroidMargins`
// only reports a margin when BOTH the own topic and the best rival clear
// MIN_CENTROID_MEMBERS = 20, and measured 2026-07-27 that leaves **34 of 131 contested
// primaries (26%) with a null margin** — every row on the six thin shelves:
//
//   differential-equations 10/10, multivariable-calculus 10/10, number-theory 9/9,
//   convex-optimization 2/2, systems-of-linear-equations 2/2, eigenvalues 1/1
//
// Those are precisely T4e's sub-0.60-purity shelves — the rows most likely to be genuinely
// mis-filed. Sorting on the margin alone parks all of them in one undifferentiated block
// at the end of the queue, so the signal is missing exactly where it is most wanted.
//
// The fix is a fallback, NOT a lower MIN_CENTROID_MEMBERS: a centroid over 14 vectors is
// a mean of too few to threshold on, which is the whole reason for the constant. Instead
// fall back to the membership's own measured `relevance` — post-T4e every membership
// carries one (the §1 stretch re-score, 777/777 measured), and it answers a closely
// related question: low purity means the neighbourhood already disagrees with the shelf.
//
// Tier 0 keeps margin-bearing rows ahead of relevance-ranked ones rather than interleaving
// them: the two scales are not comparable (a margin is a difference of cosines, a purity
// is a fraction of k), and pretending otherwise would invent an ordering the data does not
// support. Within a tier, lower is more urgent.
export function queuePriority(row: DrainRow): readonly [number, number] {
  return row.margin !== null ? [0, row.margin] : [1, row.relevance];
}

function comparePriority(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

// Groups the queue by root container and orders both the groups and the rows inside them.
// `parents` supplies the chain for ancestors that are not themselves in the queue (a
// container is often uncontested while its children are contested).
//
// Ties break on id everywhere so a re-run of the same queue presents in the same order —
// a reviewer working a batch across two sessions should not see it reshuffle.
export function groupQueue(
  rows: DrainRow[],
  parents: Map<string, ParentLink>,
): DrainGroup[] {
  const byId = new Map(parents);
  for (const r of rows) if (!byId.has(r.resourceId)) byId.set(r.resourceId, { parentId: r.parentId });

  const groups = new Map<string, DrainRow[]>();
  for (const row of rows) {
    // A top-level row keys on ITSELF, not on a shared null bucket — otherwise a contested
    // container and its contested children land in different groups (see DrainGroup).
    const key = rootContainerOf(row, byId) ?? row.resourceId;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()]
    .map(([rootId, groupRows]) => {
      const sorted = [...groupRows].sort(
        (a, b) =>
          comparePriority(queuePriority(a), queuePriority(b)) ||
          a.resourceId.localeCompare(b.resourceId),
      );
      return { rootId, rows: sorted, priority: queuePriority(sorted[0]) };
    })
    .sort(
      (a, b) => comparePriority(a.priority, b.priority) || a.rootId.localeCompare(b.rootId),
    );
}

// How the OTHER rows in a container are filed — the provenance evidence that breaks k-NN's
// circularity. A container whose 40 uncontested children are all `linear-algebra` says
// something about its 11 contested ones that their own neighbourhood cannot, because the
// neighbourhood is largely those same siblings.
export function filingHistogram(topics: string[]): Array<{ topic: string; n: number }> {
  const counts = new Map<string, number>();
  for (const t of topics) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([topic, n]) => ({ topic, n }))
    .sort((a, b) => b.n - a.n || a.topic.localeCompare(b.topic));
}
