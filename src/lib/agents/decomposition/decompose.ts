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
import { classify } from './router';
import { decomposePlaylist } from './youtube';

// What decompose() needs about a resource: classification inputs (url, type)
// plus the context a router needs to build children — topic + difficulty
// (children inherit difficulty) and the parent's first-pass concepts (a
// grounding signal for per-child concept derivation, decision A).
export type DecomposeInput = {
  url: string;
  title: string;
  type: string;
  topic: string;
  difficulty: string;
  summary: string;
  conceptsTaught: string[];
};

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

export async function decompose(input: DecomposeInput): Promise<DecompositionResult> {
  const plan = classify(input);

  switch (plan.kind) {
    case 'atomic':
      return { status: 'atomic', children: [] };

    case 'youtube_playlist': {
      const result = await decomposePlaylist({
        playlistId: plan.playlistId,
        topic: input.topic,
        difficulty: input.difficulty,
        parentConcepts: input.conceptsTaught,
      });
      if (result.ok) {
        console.log('[decompose] playlist decomposed', {
          url: input.url,
          children: result.children.length,
          truncated: result.truncated,
        });
        return { status: 'decomposed', children: result.children };
      }
      console.log('[decompose] playlist not decomposed', {
        url: input.url,
        outcome: result.outcome,
        reason: result.reason,
      });
      return { status: result.outcome, children: [] };
    }

    // doc_toc router lands in 2.5b-3; unsupported platforms are never crawled.
    // Both park the parent as a container awaiting manual curation.
    case 'doc_toc':
    case 'unsupported':
      console.log('[decompose] routed to human_review', { url: input.url, kind: plan.kind });
      return { status: 'human_review', children: [] };
  }
}
