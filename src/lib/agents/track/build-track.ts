// Phase 2.5e-3: the Track builder orchestrator — the per-request entry point that
// turns a spine_ready Path (concept map) into a frozen, immutable Track for one
// learner. It composes the deterministic scaffold (2.5e-1) around the one LLM
// judgment pass (2.5e-2) and the closure enforcement (2.5e-2b):
//
//   load spine_ready map (concepts + edges + candidates)
//     → compose (prune known, rank frontier by mastery, pick primaries, frame) [LLM]
//     → validate (inclusion closure, primary fallback, DAG order)              [pure]
//     → trim to budget (closure-aware; spine never trimmed)                    [pure]
//     → if composer flagged resources insufficient: thicken + rebuild (bounded)
//     → persist Lessons + LessonResources (primary + frozen alternates, newtab)
//     → freeze Track.status = ready
//
// Immutability + idempotency: every build creates a FRESH Track; nothing here
// mutates the Path map, and a failed build flips that one Track to `failed` (for
// diagnostics) without touching anything else — a later build replaces it. The
// lesson writes run in a single transaction so a failure never leaves a half-Track.
//
// deliveryMode is hardcoded `newtab` (the safe default: open in a new tab + mark
// complete) until the 2.5i classifier backfills per-resource embed/native modes.
//
// Synchronous today; structured to move async later (see thicken-seam.ts).

import { Difficulty, DeliveryMode, LessonResourceRole, PathStatus, TrackStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { topoSort, type OrderEdge } from '@/lib/agents/map/order';
import {
  composeTrack,
  type ComposerInputConcept,
  type ComposerResult,
} from '@/lib/agents/track/composer';
import {
  validateComposition,
  type ValidatedLesson,
} from '@/lib/agents/track/validate-composition';
import { lessonPrereqKeys, budgetMinutesFor } from '@/lib/agents/track/plan';
import { allocate, type AllocatorLesson } from '@/lib/agents/track/allocate';
import { thickenSpine } from '@/lib/agents/track/thicken-seam';
import { TRACK_MAX_THICKEN_ATTEMPTS } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type BuildTrackInput = {
  pathId: string;
  priorKnowledge?: string | null;
  // The learner's free-text statement of why they're taking this Track. Persisted
  // raw on the Track; the composer infers a coarse `intent` enum from it (2.5e-6).
  goal?: string | null;
  timeframeWeeks?: number | null;
  hoursPerWeek?: number | null;
  // Defaults to `beginner` when omitted; drives composer depth + difficulty-match.
  targetMastery?: Difficulty | null;
  onTrace?: OnTrace;
};

export type BuildTrackResult = {
  trackId: string;
  status: TrackStatus;
  lessonCount: number;
  // Diagnostics — a Track can be `ready` yet weak along either axis (ROADMAP 2.5e):
  // budgetWeak = couldn't fit the breadth (mastery-relevant frontier dropped, or the
  // required spine floor alone exceeds budget);
  // depthConstrained = a kept lesson couldn't fit its full mandatory core (the budget
  // bought less depth than the composer judged ideal);
  // underResourced = concepts the composer judged thin (thickener couldn't help yet).
  budgetWeak: boolean;
  depthConstrained: boolean;
  underResourced: string[];
  warnings: string[];
};

export class TrackBuildError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TrackBuildError';
  }
}

export async function buildTrack(input: BuildTrackInput): Promise<BuildTrackResult> {
  const { pathId, priorKnowledge, goal, timeframeWeeks, hoursPerWeek, onTrace = () => {} } = input;
  const targetMastery = input.targetMastery ?? Difficulty.beginner;
  const budgetMinutes = budgetMinutesFor(timeframeWeeks, hoursPerWeek);

  // --- gate on spine_ready (before any Track row exists) -------------------
  const path = await prisma.path.findUnique({
    where: { id: pathId },
    select: { id: true, topic: true, status: true },
  });
  if (!path) throw new TrackBuildError(`No Path '${pathId}'.`);
  if (path.status !== PathStatus.spine_ready) {
    throw new TrackBuildError(
      `Path '${pathId}' is '${path.status}', not spine_ready — cannot build a Track. ` +
        `Spine-hole remediation is the thickener's job (2.5f).`,
    );
  }

  onTrace({ kind: 'stage', label: 'track build started', detail: { pathId, topic: path.topic, targetMastery, budgetMinutes } });

  // Every build attempt gets a Track row up front, so a failure is a visible
  // `failed` Track (diagnostic) rather than nothing. Inputs are recorded now.
  const track = await prisma.track.create({
    data: {
      pathId,
      status: TrackStatus.building,
      priorKnowledge: priorKnowledge ?? null,
      goal: goal ?? null,
      timeframeWeeks: timeframeWeeks ?? null,
      hoursPerWeek: hoursPerWeek ?? null,
      targetMastery,
    },
    select: { id: true },
  });

  try {
    // --- compose → validate, with a bounded thicken-and-rebuild loop -------
    let composition: ComposerResult;
    let validatedLessons: ValidatedLesson[];
    let edges: OrderEdge[];
    let concepts: ComposerInputConcept[];
    let warnings: string[];
    for (let attempt = 0; ; attempt++) {
      const loaded = await loadMap(pathId);
      edges = loaded.edges;
      concepts = loaded.concepts;
      composition = await composeTrack({
        topic: path.topic,
        concepts: loaded.concepts,
        priorKnowledge,
        goal,
        targetMastery,
        budgetMinutes,
        onTrace,
      });
      const validation = validateComposition({ composition, concepts: loaded.concepts, edges });
      validatedLessons = validation.lessons;
      warnings = validation.warnings;

      // Axis-1 (resource) insufficiency → thicken + rebuild, bounded. Stub returns
      // not-thickened today, so we fall through to best-effort on the first pass.
      if (composition.resourceSufficiency.enough || attempt >= TRACK_MAX_THICKEN_ATTEMPTS) break;
      const thicken = await thickenSpine({
        pathId,
        underResourced: composition.resourceSufficiency.underResourced,
      });
      onTrace({ kind: 'stage', label: 'thicken attempt', detail: { attempt, ...thicken } });
      if (!thicken.thickened) break; // best-effort weaker Track
    }

    // --- allocate: breadth (closure-aware budget trim) + depth -------------
    // Join real durations from the loaded candidates so the allocator can size
    // slices; map each validated lesson to the allocator's input contract.
    const durationById = new Map<string, number>();
    for (const cpt of concepts) for (const cand of cpt.candidates) durationById.set(cand.resourceId, cand.durationMin);
    const durOf = (id: string) => durationById.get(id) ?? 0;

    const keyOf = (i: number) => `L${i}`;
    const byKey = new Map(validatedLessons.map((lesson, i) => [keyOf(i), lesson]));
    const allocLessons: AllocatorLesson[] = validatedLessons.map((l, i) => ({
      key: keyOf(i),
      isFrontier: l.isFrontier,
      masteryRelevant: l.masteryRelevant,
      timeWeight: l.timeWeight,
      mandatory: l.mandatoryResourceIds.map((id) => ({ resourceId: id, durationMin: durOf(id) })),
      optional: l.optionalResourceIds.map((id) => ({ resourceId: id, durationMin: durOf(id) })),
    }));
    const prereqKeys = lessonPrereqKeys(
      validatedLessons.map((l, i) => ({ key: keyOf(i), conceptSlugs: l.conceptSlugs })),
      edges,
    );
    const allocation = allocate({ lessons: allocLessons, budgetMinutes, prereqKeys });

    if (allocation.kept.length === 0) {
      throw new TrackBuildError(`Track build for Path '${pathId}' produced no lessons.`);
    }

    // --- persist + freeze (one transaction) --------------------------------
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < allocation.kept.length; i++) {
        const a = allocation.kept[i];
        const v = byKey.get(a.key)!;
        const lesson = await tx.lesson.create({
          data: {
            trackId: track.id,
            orderInTrack: i + 1,
            title: v.title,
            summary: v.summary,
            conceptsTaught: v.conceptSlugs,
            estMinutes: a.estMinutes,
          },
          select: { id: true },
        });
        // One ordered sequence (orderInLesson): the mandatory core (multiple
        // role=primary) first, then the frozen optional/alternate substitute pool.
        // Invalidation policy (future): when the mandatory set degrades below viable
        // — a core resource goes hard-dead — promote the highest-graded optional into
        // the core; multi-primary also degrades gracefully (the other mandatory
        // resources still teach the concept).
        let order = 0;
        await tx.lessonResource.createMany({
          data: [
            ...a.primaries.map((p) => ({
              lessonId: lesson.id,
              resourceId: p.resourceId,
              role: LessonResourceRole.primary,
              deliveryMode: DeliveryMode.newtab,
              orderInLesson: ++order,
            })),
            ...a.alternates.map((alt) => ({
              lessonId: lesson.id,
              resourceId: alt.resourceId,
              role: LessonResourceRole.alternate,
              deliveryMode: DeliveryMode.newtab,
              orderInLesson: ++order,
            })),
          ],
        });
      }
      await tx.track.update({
        where: { id: track.id },
        data: {
          status: TrackStatus.ready,
          title: composition.trackTitle,
          summary: composition.trackSummary,
          // Inferred by the composer from the learner's goal (2.5e-6); recorded on
          // the frozen Track for downstream stages + analytics.
          intent: composition.intent,
        },
      });
    });

    const underResourced = composition.resourceSufficiency.enough
      ? []
      : composition.resourceSufficiency.underResourced.map((u) => u.conceptSlug);
    onTrace({
      kind: 'stage',
      label: 'track build done',
      detail: {
        trackId: track.id,
        lessons: allocation.kept.length,
        budgetWeak: allocation.budgetWeak,
        depthConstrained: allocation.depthConstrained,
        underResourced,
      },
    });
    console.log('[track-build-track] built', {
      pathId,
      trackId: track.id,
      lessons: allocation.kept.length,
      dropped: allocation.dropped.length,
      totalMinutes: allocation.totalMinutes,
      budgetWeak: allocation.budgetWeak,
      depthConstrained: allocation.depthConstrained,
      underResourced,
    });

    return {
      trackId: track.id,
      status: TrackStatus.ready,
      lessonCount: allocation.kept.length,
      budgetWeak: allocation.budgetWeak,
      depthConstrained: allocation.depthConstrained,
      underResourced,
      warnings,
    };
  } catch (err) {
    // Flip this one Track to `failed` for diagnostics; the Path map is untouched.
    await prisma.track
      .update({ where: { id: track.id }, data: { status: TrackStatus.failed } })
      .catch(() => {});
    throw new TrackBuildError(`Failed to build Track for Path '${pathId}'.`, err);
  }
}

// Load a Path's concepts as composer inputs, in topo order, each with its
// candidate ConceptResources (coverage-desc), plus the prereq edge list.
async function loadMap(
  pathId: string,
): Promise<{ concepts: ComposerInputConcept[]; edges: OrderEdge[] }> {
  const rows = await prisma.concept.findMany({
    where: { pathId },
    select: {
      slug: true,
      title: true,
      membership: true,
      prereqsIn: { select: { from: { select: { slug: true } } } },
      resources: {
        select: {
          role: true,
          coverageScore: true,
          resource: {
            select: { id: true, title: true, type: true, difficulty: true, durationMin: true },
          },
        },
        orderBy: { coverageScore: 'desc' },
      },
    },
  });

  const edges: OrderEdge[] = rows.flatMap((c) =>
    c.prereqsIn.map((e) => ({ fromSlug: e.from.slug, toSlug: c.slug })),
  );
  const pos = new Map(topoSort(rows.map((r) => ({ slug: r.slug })), edges).map((s, i) => [s, i]));

  const concepts: ComposerInputConcept[] = rows
    .map((c) => ({
      slug: c.slug,
      title: c.title,
      membership: c.membership,
      candidates: c.resources.map((r) => ({
        resourceId: r.resource.id,
        role: r.role,
        coverageScore: r.coverageScore,
        title: r.resource.title,
        type: r.resource.type,
        difficulty: r.resource.difficulty,
        durationMin: r.resource.durationMin,
      })),
    }))
    .sort((a, b) => (pos.get(a.slug) ?? 0) - (pos.get(b.slug) ?? 0));

  return { concepts, edges };
}
