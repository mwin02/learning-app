// Phase 2.5b — decomposition orchestrator (the shared entry point).
//
// `decompose(resource)` is called once per resource AFTER it has been
// discovered + validated (web fallback) or read from the seed (backfill,
// 2.5b-4). It classifies the resource and, where a router exists, explodes it
// into atomic child units. It does NOT touch the database — it returns a plan
// the caller persists via upsertResource(), so discovery and the seed script
// share one decomposition path (ROADMAP 2.5b decision #6).
//
// 2.5b-1 scope: only the `atomic` fast-path produces a real result. Every
// container-shaped resource (playlist, doc tree, paywalled platform) returns
// `human_review` with no children — the parent row exists but is unpickable
// until its router lands in 2.5b-2/-3. Children carry per-child concepts; their
// derivation + canonicalization (decision A) lands with the first real router.

import type { DecompositionStatus } from '@prisma/client';
import { classify, type ClassifiableResource } from './router';

// One atomic child produced by a router. Inherits topic / sourceId / trustScore
// / language from its parent at upsert time, so those are absent here.
export type ChildInput = {
  url: string;
  title: string;
  type: string;
  difficulty: string;
  durationMin: number;
  summary: string;
  prerequisiteConcepts: string[];
  conceptsTaught: string[];
  orderInParent: number;
};

export type DecompositionResult = {
  status: DecompositionStatus;
  children: ChildInput[];
};

export async function decompose(
  resource: ClassifiableResource,
): Promise<DecompositionResult> {
  const plan = classify(resource);

  switch (plan.kind) {
    case 'atomic':
      return { status: 'atomic', children: [] };

    // Routers not yet implemented (2.5b-2 youtube_playlist, 2.5b-3 doc_toc) and
    // platforms we never crawl (unsupported) all park the parent as a container
    // awaiting manual curation. No children until the router ships.
    case 'youtube_playlist':
    case 'doc_toc':
    case 'unsupported':
      console.log('[decompose] routed to human_review', {
        url: resource.url,
        kind: plan.kind,
      });
      return { status: 'human_review', children: [] };
  }
}
