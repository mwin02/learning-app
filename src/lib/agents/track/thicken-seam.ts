// Phase 2.5e-3 / 2.5f-5: the in-track spine thickener.
//
// When the composer judges a concept's resources insufficient for the learner's
// TARGET MASTERY (resourceSufficiency.enough === false), the Track builder asks
// the thickener to source more, then rebuilds. NOTE this is NOT spine-hole
// remediation: build-track gates on `spine_ready`, so these concepts already have
// a qualifying primary — they're just too shallow for the requested depth. So the
// thickener sources per-concept biased toward `targetMastery` and attaches the
// keepers (reusing sourceAndAttachConcept, the same primitive remediation uses);
// it does NOT touch readiness gating.
//
// Synchronous today: build-track awaits this inline, so a thicken cycle adds the
// per-concept web-search latency to the build (bounded by TRACK_MAX_THICKEN_
// ATTEMPTS). Making it "mark building → enqueue → completion re-invokes build" is
// the 2.5g async cutover; the contract here is unchanged by that move.

import { Difficulty } from '@prisma/client';
import { prisma } from '@/lib/db';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';

export type ThickenRequest = {
  pathId: string;
  // The concepts the composer flagged as under-resourced for the target mastery.
  underResourced: { conceptSlug: string; reason: string }[];
  // The learner's target mastery — biases discovery toward that depth.
  targetMastery: Difficulty;
};

export type ThickenResult = {
  // True only if new candidates were actually attached — the builder rebuilds when
  // true, and proceeds best-effort when false.
  thickened: boolean;
  reason: string;
};

export async function thickenSpine(req: ThickenRequest): Promise<ThickenResult> {
  const { pathId, underResourced, targetMastery } = req;
  if (underResourced.length === 0) return { thickened: false, reason: 'no under-resourced concepts' };

  const slugs = underResourced.map((u) => u.conceptSlug);
  const path = await prisma.path.findUnique({ where: { id: pathId }, select: { topic: true } });
  if (!path) return { thickened: false, reason: `no Path '${pathId}'` };

  const concepts = await prisma.concept.findMany({
    where: { pathId, slug: { in: slugs } },
    select: { id: true, slug: true, title: true, isOnRamp: true },
  });

  console.log('[track-thicken] sourcing', { pathId, concepts: concepts.map((c) => c.slug), targetMastery });

  let attached = 0;
  for (const c of concepts) {
    attached += await sourceAndAttachConcept({
      pathId,
      topic: path.topic,
      conceptId: c.id,
      slug: c.slug,
      title: c.title,
      targetMastery,
      isOnRamp: c.isOnRamp,
    });
  }

  return attached > 0
    ? { thickened: true, reason: `attached ${attached} new candidate(s) across ${concepts.length} concept(s)` }
    : { thickened: false, reason: 'sourced nothing new for the under-resourced concepts' };
}
