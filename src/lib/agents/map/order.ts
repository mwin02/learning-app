// Phase 2.5e-1: pure linearization over a concept prereq DAG — shared by the
// map inspector (longest-path layering for display) and the Track builder
// (topo-sort for lesson ordering). Both want the same machinery: turn a set of
// concepts plus directed prerequisite edges (`from` is a prerequisite of `to`)
// into an order that respects every edge. Keeping one tested implementation here
// avoids the inspector and the Track builder drifting apart.
//
// Pure — no DB, no model — and string-key agnostic (slugs or ids). The builders
// guarantee acyclicity (cycle.ts validates before persist); the cycle guards
// below are defensive only, so a stray back-edge degrades to a best-effort order
// instead of looping forever.

export type OrderConcept = { slug: string };
// Matches ConceptPrereq's direction: `from` is the prerequisite, `to` depends
// on it. Same shape the persisted edges carry, so callers pass them through.
export type OrderEdge = { fromSlug: string; toSlug: string };

// Linearize the DAG into a single teaching order: every concept appears after
// all of its prerequisites. Kahn's algorithm with a deterministic tie-break —
// among concepts whose prerequisites are all satisfied, the lexicographically
// smallest slug goes next — so the same map always yields the same order (a
// requirement for reproducible, immutable Track snapshots).
//
// Concepts with no edge to them and no edge from them still appear (isolated
// nodes are valid spine concepts). If a cycle slips through, the nodes trapped
// in it are appended in slug order after the acyclic prefix rather than dropped.
export function topoSort(concepts: OrderConcept[], edges: OrderEdge[]): string[] {
  const slugs = concepts.map((c) => c.slug);
  const slugSet = new Set(slugs);
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const slug of slugs) {
    indegree.set(slug, 0);
    adjacency.set(slug, []);
  }
  // Only edges between known concepts count; a dangling endpoint is ignored here
  // (cycle.ts already reports it as a defect at build time).
  for (const e of edges) {
    if (!slugSet.has(e.fromSlug) || !slugSet.has(e.toSlug)) continue;
    adjacency.get(e.fromSlug)!.push(e.toSlug);
    indegree.set(e.toSlug, indegree.get(e.toSlug)! + 1);
  }

  // Ready = indegree 0, kept slug-sorted so the smallest is always taken next.
  const ready = slugs.filter((s) => indegree.get(s) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    for (const child of adjacency.get(node)!) {
      const d = indegree.get(child)! - 1;
      indegree.set(child, d);
      if (d === 0) insertSorted(ready, child);
    }
  }

  // Defensive: any concept never reaching indegree 0 is in a cycle. Append the
  // remainder in slug order so the caller still gets every concept.
  if (order.length < slugs.length) {
    const placed = new Set(order);
    for (const s of slugs.filter((s) => !placed.has(s)).sort()) order.push(s);
  }
  return order;
}

// Longest-path layering for display: layer 0 = a concept with no prerequisites,
// else 1 + max(layer of its prerequisites). Concepts in the same layer have the
// same prerequisite depth and render side by side. This reproduces the inspector's
// original inline layering; it is a *grouping*, not a linear order (use topoSort
// for that). Computed over the topo order so every prerequisite's layer is known
// before the concept that depends on it.
export function layerBySlug(
  concepts: OrderConcept[],
  edges: OrderEdge[],
): Map<string, number> {
  const slugSet = new Set(concepts.map((c) => c.slug));
  // prereqs[to] = its prerequisite slugs (incoming edges).
  const prereqs = new Map<string, string[]>();
  for (const c of concepts) prereqs.set(c.slug, []);
  for (const e of edges) {
    if (!slugSet.has(e.fromSlug) || !slugSet.has(e.toSlug)) continue;
    prereqs.get(e.toSlug)!.push(e.fromSlug);
  }

  const layer = new Map<string, number>();
  for (const slug of topoSort(concepts, edges)) {
    const preds = prereqs.get(slug) ?? [];
    // Predecessors precede `slug` in topo order, so their layers are already set.
    // A predecessor trapped in a cycle (absent here) defaults to 0.
    const maxPred = preds.reduce((m, p) => Math.max(m, layer.get(p) ?? 0), -1);
    layer.set(slug, maxPred + 1);
  }
  return layer;
}

// Insert into an already slug-sorted array keeping it sorted (binary search).
// Keeps Kahn's ready set ordered without re-sorting the whole array each step.
function insertSorted(sorted: string[], value: string): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, value);
}
