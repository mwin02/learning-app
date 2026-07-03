// Phase 2.5e-3 / 2.5f-5: the in-track spine thickener.
//
// When the composer judges a concept's resources insufficient for the learner's
// TARGET MASTERY (resourceSufficiency.enough === false) — or, Budget-fill Block 2,
// teachable but too THIN for the budget's depth tier (thinForBudget) — the Track
// builder asks the thickener to source more, then rebuilds. NOTE this is NOT
// spine-hole remediation: build-track gates on `spine_ready`, so these concepts
// already have a qualifying primary — they're just too shallow for the requested
// depth. So the thickener sources per-concept biased toward `targetMastery` (and,
// for budget-thin concepts, toward SUBSTANTIAL durations) and attaches the keepers
// (reusing sourceAndAttachConcept, the same primitive remediation uses); it does
// NOT touch readiness gating. One cycle sources at most TRACK_MAX_THICKEN_CONCEPTS
// concepts, worst-first (see selectThickenTargets).
//
// Synchronous today: build-track awaits this inline, so a thicken cycle adds the
// per-concept web-search latency to the build (bounded by TRACK_MAX_THICKEN_
// ATTEMPTS). Making it "mark building → enqueue → completion re-invokes build" is
// the 2.5g async cutover; the contract here is unchanged by that move.

import { Difficulty } from '@prisma/client';
import { prisma } from '@/lib/db';
import { TRACK_MAX_THICKEN_CONCEPTS } from '@/lib/config';
import { sourceAndAttachConcept } from '@/lib/agents/track/source-concept';

export type ThickenRequest = {
  pathId: string;
  // The concepts the composer flagged as under-resourced for the target mastery.
  underResourced: { conceptSlug: string; reason: string }[];
  // Budget-fill Block 2: concepts the composer judged teachable but too thin for
  // the depth tier (resourceSufficiency.thinForBudget). Sourced with the
  // substantial-duration bias — the library is overwhelmingly ≤30m clips, and more
  // clips can't fill a deep-tier core.
  thinForBudget?: { conceptSlug: string; reason: string }[];
  // The learner's target mastery — biases discovery toward that depth.
  targetMastery: Difficulty;
};

// Worst-first target selection under the per-cycle cap: teachability holes (a
// concept that can't be taught AT ALL) outrank budget-thin ones (teachable, just
// shallow), each list keeping the composer's own order; a slug in both lists is a
// teachability hole (underResourced wins, no double-sourcing). Pure — exported for
// unit tests.
export function selectThickenTargets(
  underResourced: { conceptSlug: string; reason: string }[],
  thinForBudget: { conceptSlug: string; reason: string }[],
  cap: number = TRACK_MAX_THICKEN_CONCEPTS,
): { conceptSlug: string; reason: string; preferSubstantial: boolean }[] {
  const seen = new Set<string>();
  const out: { conceptSlug: string; reason: string; preferSubstantial: boolean }[] = [];
  for (const u of underResourced) {
    if (seen.has(u.conceptSlug)) continue;
    seen.add(u.conceptSlug);
    out.push({ ...u, preferSubstantial: false });
  }
  for (const t of thinForBudget) {
    if (seen.has(t.conceptSlug)) continue;
    seen.add(t.conceptSlug);
    out.push({ ...t, preferSubstantial: true });
  }
  return out.slice(0, cap);
}

export type ThickenResult = {
  // True only if new candidates were actually attached — the builder rebuilds when
  // true, and proceeds best-effort when false.
  thickened: boolean;
  reason: string;
};

export async function thickenSpine(req: ThickenRequest): Promise<ThickenResult> {
  const { pathId, underResourced, thinForBudget = [], targetMastery } = req;
  const targets = selectThickenTargets(underResourced, thinForBudget);
  if (targets.length === 0) return { thickened: false, reason: 'no under-resourced or budget-thin concepts' };

  const path = await prisma.path.findUnique({ where: { id: pathId }, select: { topic: true } });
  if (!path) return { thickened: false, reason: `no Path '${pathId}'` };

  const bySlug = new Map(targets.map((t) => [t.conceptSlug, t]));
  const concepts = await prisma.concept.findMany({
    where: { pathId, slug: { in: targets.map((t) => t.conceptSlug) } },
    select: { id: true, slug: true, title: true, isOnRamp: true },
  });

  console.log('[track-thicken] sourcing', {
    pathId,
    concepts: concepts.map((c) => c.slug),
    thin: targets.filter((t) => t.preferSubstantial).map((t) => t.conceptSlug),
    capped: underResourced.length + thinForBudget.length > targets.length,
    targetMastery,
  });

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
      preferSubstantial: bySlug.get(c.slug)?.preferSubstantial ?? false,
    });
  }

  return attached > 0
    ? { thickened: true, reason: `attached ${attached} new candidate(s) across ${concepts.length} concept(s)` }
    : { thickened: false, reason: 'sourced nothing new for the flagged concepts' };
}
