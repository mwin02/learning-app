// Frontier-build orchestrator — author → sanitize → cycle-check → bounded repair.
//
// Mirrors build-spine.ts's shape but with weaker failure semantics: the frontier
// is optional enrichment that never gates spine_ready, so this NEVER throws.
// Slug/prereq hygiene defects are fixed deterministically by the sanitizer (no
// repair call spent on them); only a cycle among the new nodes — the one defect
// a deterministic fix would resolve arbitrarily — goes back to the author, and
// once FRONTIER_MAX_REPAIRS is exhausted we break remaining cycles by dropping
// edges and ship what we have. Worst case is an empty plan (author kept
// throwing), which callers treat as "no frontier authored" — today's state.
//
// Pure except for the author call, so sanitize/cycle/break unit-test in
// isolation and the orchestrator tests with a mocked author.

import { authorFrontier, type AuthoredFrontierConcept } from '@/lib/agents/map/frontier-author';
import { findCycle, type AuthoredEdge } from '@/lib/agents/map/cycle';
import { FRONTIER_MAX_CONCEPTS, FRONTIER_MAX_REPAIRS } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A validated, persistable frontier: new concepts plus prerequisite edges whose
// `toSlug` is always a NEW concept (fromSlug may be existing or new) — the
// downward-closed invariant, guaranteed by the per-node prerequisiteSlugs shape.
export type FrontierPlan = {
  concepts: { slug: string; title: string }[];
  edges: AuthoredEdge[];
};

// Deterministic hygiene over the author's raw output. Drops (never repairs):
//   - concepts with an empty/malformed slug or a too-short title,
//   - duplicate slugs within the batch (first wins — author order is priority),
//   - slugs colliding with an existing map concept (a missed dedup: the idea is
//     already on the map, so authoring it again adds nothing),
//   - overflow past FRONTIER_MAX_CONCEPTS (truncate; the prompt orders by
//     importance, so truncation keeps the author's own top picks),
// then filters each kept concept's prerequisiteSlugs to slugs that exist (on the
// map or among kept new concepts), dropping self-references and invented slugs —
// same silent-filter policy as add-frontier-concept. A concept whose prereqs all
// drop stays (a frontier root), it just anchors nowhere.
export function sanitizeFrontier(
  existingSlugs: Set<string>,
  authored: AuthoredFrontierConcept[],
): FrontierPlan {
  const kept: AuthoredFrontierConcept[] = [];
  const keptSlugs = new Set<string>();
  for (const c of authored) {
    const slug = (c.slug ?? '').trim();
    const title = (c.title ?? '').trim();
    if (!SLUG_PATTERN.test(slug) || title.length < 2) continue;
    if (existingSlugs.has(slug) || keptSlugs.has(slug)) continue;
    if (kept.length >= FRONTIER_MAX_CONCEPTS) break;
    kept.push({ slug, title, prerequisiteSlugs: c.prerequisiteSlugs ?? [] });
    keptSlugs.add(slug);
  }

  const edges: AuthoredEdge[] = [];
  const seen = new Set<string>();
  for (const c of kept) {
    for (const p of c.prerequisiteSlugs) {
      if (p === c.slug) continue;
      if (!existingSlugs.has(p) && !keptSlugs.has(p)) continue;
      const key = JSON.stringify([p, c.slug]);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromSlug: p, toSlug: c.slug });
    }
  }
  return { concepts: kept.map(({ slug, title }) => ({ slug, title })), edges };
}

// Find a prerequisite cycle among the NEW nodes, or null. Only new→new edges can
// participate: an existing concept has no incoming edge from a new node (edges
// only point INTO new nodes), so it can never sit on a cycle.
export function frontierCycle(plan: FrontierPlan): string[] | null {
  const newSlugs = new Set(plan.concepts.map((c) => c.slug));
  const adjacency = new Map<string, string[]>();
  for (const s of newSlugs) adjacency.set(s, []);
  for (const e of plan.edges) {
    if (newSlugs.has(e.fromSlug) && newSlugs.has(e.toSlug)) {
      adjacency.get(e.fromSlug)!.push(e.toSlug);
    }
  }
  return findCycle(adjacency);
}

// Deterministic last resort once the repair budget is spent: repeatedly drop the
// edge that closes the detected cycle until the plan is acyclic. Loses an edge's
// pedagogy (arbitrarily, unlike an author repair) but never a concept — an
// unanchored frontier node is still composable enrichment.
export function breakCycles(plan: FrontierPlan): FrontierPlan {
  let edges = plan.edges;
  for (let cycle = frontierCycle({ ...plan, edges }); cycle; cycle = frontierCycle({ ...plan, edges })) {
    const [from, to] = [cycle[cycle.length - 2], cycle[cycle.length - 1]];
    edges = edges.filter((e) => !(e.fromSlug === from && e.toSlug === to));
  }
  return { concepts: plan.concepts, edges };
}

// Author a topic's frontier as a validated plan over the existing map. Never
// throws; an empty plan means no frontier could be authored (best-effort).
export async function buildFrontier(args: {
  topic: string;
  subject?: string;
  existing: { slug: string; title: string; membership: string }[];
  onTrace?: OnTrace;
}): Promise<FrontierPlan> {
  const { topic, subject, existing, onTrace = () => {} } = args;
  const existingSlugs = new Set(existing.map((c) => c.slug));

  let repairFeedback: string | undefined;
  let lastPlan: FrontierPlan = { concepts: [], edges: [] };
  for (let attempt = 0; attempt <= FRONTIER_MAX_REPAIRS; attempt++) {
    let authored;
    try {
      authored = await authorFrontier({ topic, subject, existing, repairFeedback, onTrace });
    } catch (err) {
      // Transient infra/parse error: consume an attempt and retry without
      // feedback — there's no output to repair (same policy as build-spine).
      const message = err instanceof Error ? err.message : String(err);
      onTrace({ kind: 'stage', label: 'frontier author error', detail: { attempt, error: message } });
      console.log('[map-build-frontier] author error', { topic, attempt, error: message });
      continue;
    }

    const plan = sanitizeFrontier(existingSlugs, authored.concepts);
    const cycle = frontierCycle(plan);
    if (!cycle) {
      onTrace({
        kind: 'stage',
        label: 'frontier validated',
        detail: { attempt, concepts: plan.concepts.length, edges: plan.edges.length },
      });
      return plan;
    }

    lastPlan = plan;
    repairFeedback = `Prerequisite cycle among your new concepts: ${cycle.join(' → ')}. Break it by removing or reversing one prerequisite.`;
    onTrace({ kind: 'stage', label: 'frontier cycle; repairing', detail: { attempt, cycle } });
    console.log('[map-build-frontier] cycle; repairing', { topic, attempt, cycle });
  }

  // Repair budget exhausted (or the author never produced output). Ship the last
  // plan with cycles broken deterministically — a no-output run ships empty.
  const plan = breakCycles(lastPlan);
  onTrace({
    kind: 'stage',
    label: 'frontier repair exhausted; cycles broken',
    detail: { concepts: plan.concepts.length, edges: plan.edges.length },
  });
  return plan;
}
