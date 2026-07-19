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
// deliveryMode (2.5j) is derived per-resource from the cached `Resource.embeddable`
// flag: embeddable → `embed`, otherwise the safe `newtab` default (open in a new
// tab + mark complete). Un-probed (null) resources fall through to newtab.
//
// Synchronous today; structured to move async later (see thicken-seam.ts).

import { ConceptResourceRole, Difficulty, DeliveryMode, LessonResourceRole, PathStatus, TrackStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { continuityOrder, type OrderEdge } from '@/lib/agents/map/order';
import { selectionScore } from '@/lib/agents/map/attach-candidates';
import {
  composeTrack,
  type ComposerInputConcept,
  type ComposerResult,
} from '@/lib/agents/track/composer';
import { composeTrackAgent } from '@/lib/agents/track/composer-agent';
import {
  validateComposition,
  type ValidatedLesson,
} from '@/lib/agents/track/validate-composition';
import { lessonPrereqKeys, budgetMinutesFor } from '@/lib/agents/track/plan';
import { allocate, depthTier, type AllocatorLesson } from '@/lib/agents/track/allocate';
import { cleanupLessons } from '@/lib/agents/track/cleanup-lessons';
import { thickenSpine } from '@/lib/agents/track/thicken-seam';
import { sectionTrack } from '@/lib/agents/track/section-track';
import { exerciseTrack } from '@/lib/agents/content/exercise-track';
import {
  TRACK_MAX_THICKEN_ATTEMPTS,
  TRACK_COMPOSER_MODE,
  TRACK_MIN_PRIMARY_DURATION_MIN,
  TRACK_FILL_BAND,
} from '@/lib/config';
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
  // H4: the worker's per-job deadline signal, forwarded to the compose/section
  // LLM calls; the worker's deadline race is the backstop for everything else.
  abortSignal?: AbortSignal;
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
  // Budget-fill Block 3: kept minutes / requested budget (2dp), null when the
  // learner gave no budget. Warned on outside TRACK_FILL_BAND at build time.
  fillRatio: number | null;
  warnings: string[];
};

export class TrackBuildError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TrackBuildError';
  }
}

export async function buildTrack(input: BuildTrackInput): Promise<BuildTrackResult> {
  const { pathId, priorKnowledge, goal, timeframeWeeks, hoursPerWeek, onTrace = () => {}, abortSignal } = input;
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
      const loaded = await loadComposerMap(pathId);
      edges = loaded.edges;
      concepts = loaded.concepts;
      // TRACK_COMPOSER_MODE selects the one-shot composer (today's default) or the
      // tool-using agent (2.5e-8 block 2b); both return the same ComposerResult, so
      // everything below — validate, allocate, freeze — is identical.
      // Budget-fill Block 1: the coarse core-sizing tier, computed in code over the
      // concepts GIVEN to the composer (its own pruning only raises the true
      // per-concept budget). Recomputed per attempt — thickening doesn't change the
      // concept count, but the recompute is free and keeps the loop self-contained.
      const tier = depthTier(budgetMinutes, loaded.concepts.length);
      composition =
        TRACK_COMPOSER_MODE === 'agent'
          ? await composeTrackAgent({
              topic: path.topic,
              concepts: loaded.concepts,
              edges: loaded.edges,
              priorKnowledge,
              goal,
              targetMastery,
              budgetMinutes,
              depthTier: tier,
              onTrace,
              abortSignal,
            })
          : await composeTrack({
              topic: path.topic,
              concepts: loaded.concepts,
              priorKnowledge,
              goal,
              targetMastery,
              budgetMinutes,
              depthTier: tier,
              onTrace,
              abortSignal,
            });
      const validation = validateComposition({
        composition,
        concepts: loaded.concepts,
        edges,
        // The agent composer may borrow a resource across concepts (2c); honor those
        // explicit picks. The single-pass composer never does, so it's a no-op there.
        crossConceptResources: TRACK_COMPOSER_MODE === 'agent',
      });
      validatedLessons = validation.lessons;
      warnings = validation.warnings;

      // Axis-1 (resource) insufficiency and/or the Block-2 budget axis (teachable
      // but too thin for the depth tier) → thicken + rebuild, bounded. The
      // thickener sources biased toward the target mastery (and toward substantial
      // durations for budget-thin concepts), worst-first under a per-cycle concept
      // cap; if it attaches nothing new we fall through to a best-effort Track.
      const thinForBudget = composition.resourceSufficiency.thinForBudget;
      const needsThicken = !composition.resourceSufficiency.enough || thinForBudget.length > 0;
      if (!needsThicken || attempt >= TRACK_MAX_THICKEN_ATTEMPTS) break;
      const thicken = await thickenSpine({
        pathId,
        underResourced: composition.resourceSufficiency.underResourced,
        thinForBudget,
        targetMastery,
      });
      onTrace({ kind: 'stage', label: 'thicken attempt', detail: { attempt, ...thicken } });
      if (!thicken.thickened) break; // best-effort weaker Track
    }

    // --- 2g-5: order generated on-ramp content first -----------------------
    // The composer ranks candidates on pedagogy and routinely buries the short
    // authored on-ramp lesson behind a longer sourced resource (or in the optional
    // pool). But a generated lesson is content WE authored as the lesson's lead —
    // it should be the primary so the learn UI renders it inline as the main view,
    // not a demoted alternate. Deterministically promote it to mandatory[0] of the
    // lesson that teaches its concept (other mandatory resources stay, after it).
    const generatedIds = new Set<string>();
    for (const cpt of concepts)
      for (const cand of cpt.candidates) if (cand.isGenerated) generatedIds.add(cand.resourceId);
    validatedLessons = enforceGeneratedPrimary(validatedLessons, generatedIds);

    // Join real durations + roles from the loaded candidates: the duration floor pass
    // below and the allocator both need them (durations to size slices, roles so a
    // replacement primary is a real `teaches`).
    const durationById = new Map<string, number>();
    const roleById = new Map<string, ConceptResourceRole>();
    for (const cpt of concepts)
      for (const cand of cpt.candidates) {
        durationById.set(cand.resourceId, cand.durationMin);
        roleById.set(cand.resourceId, cand.role);
      }
    const durOf = (id: string) => durationById.get(id) ?? 0;

    // --- 2g/2.5: primary duration floor ------------------------------------
    // The composer occasionally seats a too-thin resource (a ~1-min YouTube Short) as
    // a concept's lead primary over a longer real teacher sitting in the pool. A 5s
    // clip can't deliver a concept; deterministically swap in the best non-thin
    // `teaches` candidate and demote the thin one to an alternate. No-op when the
    // primary already clears the floor or no qualifying replacement exists (≥1
    // guarantee); authored on-ramps are exempt (intentionally the primary).
    validatedLessons = enforcePrimaryDurationFloor(validatedLessons, {
      durOf,
      roleOf: (id) => roleById.get(id),
      generatedIds,
      floorMin: TRACK_MIN_PRIMARY_DURATION_MIN,
    });

    // --- allocate: breadth (closure-aware budget trim) + depth -------------
    // Map each validated lesson to the allocator's input contract.
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

    // --- cleanup: cross-lesson resource dedup + alternate cap --------------
    // One Resource can be a candidate of multiple Concepts (legitimate at the Path
    // level); within this Track it must appear in at most one lesson. Also caps each
    // lesson's optional-pool alternates to its primary count (demoted-core kept).
    const cleaned = cleanupLessons({ lessons: allocation.kept, roleById });
    warnings.push(...cleaned.warnings);

    // --- delivery mode: freeze each resource's cached embeddability ---------
    // Phase 2.5j: `deliveryMode` is per-LessonResource but DERIVED from the
    // resource's URL-level `embeddable` flag (the 2.5j classifier caches it on
    // Resource; null = un-probed). Snapshot it into the immutable Track here:
    // embeddable → `embed` (ResourcePane frames it), everything else → the safe
    // `newtab` default. One bulk read keyed by the resource ids about to persist.
    const usedResourceIds = new Set(
      cleaned.lessons.flatMap((l) => [...l.primaries, ...l.alternates].map((c) => c.resourceId)),
    );
    const embeddableById = new Map<string, boolean>();
    for (const r of await prisma.resource.findMany({
      where: { id: { in: [...usedResourceIds] } },
      select: { id: true, embeddable: true },
    })) {
      embeddableById.set(r.id, r.embeddable === true);
    }
    const deliveryModeFor = (resourceId: string) =>
      embeddableById.get(resourceId) ? DeliveryMode.embed : DeliveryMode.newtab;

    // --- persist + freeze (one transaction) --------------------------------
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < cleaned.lessons.length; i++) {
        const a = cleaned.lessons[i];
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
              deliveryMode: deliveryModeFor(p.resourceId),
              orderInLesson: ++order,
            })),
            ...a.alternates.map((alt) => ({
              lessonId: lesson.id,
              resourceId: alt.resourceId,
              role: LessonResourceRole.alternate,
              deliveryMode: deliveryModeFor(alt.resourceId),
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

    // --- best-effort sectioning: group the frozen lessons into chapters --------
    // A separate Flash pass over the just-persisted lessons (section-track.ts).
    // Non-fatal: a failure leaves the Track flat (no Sections) but `ready`, so
    // sectioning never costs the learner a build. Runs after the freeze so it sees
    // the final, trimmed lesson order.
    try {
      const sectioning = await sectionTrack({ trackId: track.id, onTrace, abortSignal });
      warnings.push(...sectioning.warnings);
    } catch (err) {
      console.warn('[track-build-track] sectioning failed (non-fatal)', { trackId: track.id, err });
      warnings.push('sectioning failed; track left flat');
    }

    // --- best-effort exercises: sample the concept banks into per-Lesson rows ------
    // A no-LLM selection pass over the frozen lessons (exercise-track.ts): pulls a
    // stratified sample from each lesson's concept question bank (2.5h-3). Non-fatal
    // like sectioning — a Path with no banks yet (or a failure here) leaves the Track
    // exercise-less but `ready`, never costing the learner a build.
    try {
      const exercises = await exerciseTrack({ trackId: track.id, onTrace });
      warnings.push(...exercises.warnings);
    } catch (err) {
      console.warn('[track-build-track] exercise selection failed (non-fatal)', { trackId: track.id, err });
      warnings.push('exercise selection failed; track has no exercises');
    }

    const underResourced = composition.resourceSufficiency.enough
      ? []
      : composition.resourceSufficiency.underResourced.map((u) => u.conceptSlug);
    // Budget-fill Block 3: fill telemetry — kept minutes over the requested budget
    // (null when no budget given). Measured on the CLEANED lessons (post cross-
    // lesson dedup), i.e. what actually persists for the learner, not the
    // allocator's pre-dedup total (which overstated LA's live re-measure 0.76 vs
    // 0.62 persisted). Logged on every budgeted build and WARNED on loudly outside
    // TRACK_FILL_BAND, so under-fill regressions (the 2026-07-02 audit's ~12–20%
    // tracks) surface in logs instead of waiting for a data audit. Telemetry only:
    // the build still succeeds either way.
    const keptMinutes = cleaned.lessons.reduce((s, l) => s + l.estMinutes, 0);
    const fillRatio =
      budgetMinutes !== null && budgetMinutes > 0
        ? Number((keptMinutes / budgetMinutes).toFixed(2))
        : null;
    if (fillRatio !== null && (fillRatio < TRACK_FILL_BAND.min || fillRatio > TRACK_FILL_BAND.max)) {
      console.warn('[track-build-track] fill outside band', {
        pathId,
        trackId: track.id,
        fillRatio,
        band: TRACK_FILL_BAND,
        keptMinutes,
        budgetMinutes,
      });
    }
    onTrace({
      kind: 'stage',
      label: 'track build done',
      detail: {
        trackId: track.id,
        lessons: allocation.kept.length,
        pruned: composition.prune.length,
        omittedForIntent: composition.omitForIntent.length,
        budgetWeak: allocation.budgetWeak,
        depthConstrained: allocation.depthConstrained,
        fillRatio,
        underResourced,
      },
    });
    console.log('[track-build-track] built', {
      pathId,
      trackId: track.id,
      lessons: allocation.kept.length,
      dropped: allocation.dropped.length,
      pruned: composition.prune.length,
      omittedForIntent: composition.omitForIntent.length,
      totalMinutes: allocation.totalMinutes,
      fillRatio,
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
      fillRatio,
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
// candidate ConceptResources (coverage-desc), plus the prereq edge list. Exported so
// the composer parity harness (scripts/compare-composers.ts) loads a map exactly the
// way a real build does.
// Phase 2g-5: make a generated lesson (the AI-authored on-ramp) the PRIMARY of its
// lesson, ordered first. The composer grades candidates on pedagogy and routinely
// ranks the short authored orientation behind a longer sourced resource — or drops it
// into the optional pool — so without this it renders as a demoted alternate instead
// of the lesson's lead. For each lesson holding a generated candidate (in either
// pool), move it to the front of the mandatory core and out of the optional pool;
// other mandatory resources are preserved AFTER it (a merged on-ramp+X lesson keeps
// X's resource as a secondary primary). Pure; no-op when a lesson has no generated
// candidate or it already leads. One on-ramp per spine, so at most one per lesson, but
// generic over several.
export function enforceGeneratedPrimary(
  lessons: ValidatedLesson[],
  generatedIds: Set<string>,
): ValidatedLesson[] {
  if (generatedIds.size === 0) return lessons;
  return lessons.map((l) => {
    const gen = [...new Set([...l.mandatoryResourceIds, ...l.optionalResourceIds])].filter((id) =>
      generatedIds.has(id),
    );
    if (gen.length === 0) return l;
    // Already leading the mandatory core in order → nothing to do.
    if (gen.every((id, i) => l.mandatoryResourceIds[i] === id)) return l;
    const genSet = new Set(gen);
    return {
      ...l,
      mandatoryResourceIds: [...gen, ...l.mandatoryResourceIds.filter((id) => !genSet.has(id))],
      optionalResourceIds: l.optionalResourceIds.filter((id) => !genSet.has(id)),
    };
  });
}

// Deterministic primary duration-floor pass. The composer ranks the mandatory core
// on pedagogy and, nondeterministically, sometimes leads a lesson with a too-thin
// resource (a ~1-min YouTube Short) while a longer real teacher sits in the pool —
// a clip too short to actually deliver the concept. For each lesson whose lead
// primary (`mandatoryResourceIds[0]`) falls below `floorMin`, promote the best
// non-thin `teaches` candidate from THIS lesson's own pools (the mandatory tail
// first — the composer already ranked it core — then the optional pool) to the lead
// and demote the thin one into the optional pool (kept as an alternate, never
// dropped). Priority order within each pool is preserved, so the highest-ranked
// qualifying teacher wins.
//
// Conservative by construction:
//   - No-op when the lead already clears the floor, or no qualifying `teaches`
//     replacement exists — the thin primary stays (the ≥1 guarantee: a concept with
//     only thin candidates keeps its clip rather than lose its lesson).
//   - Authored on-ramps (`generatedIds`) are exempt — a generated lesson is content
//     WE authored as the lead (enforceGeneratedPrimary just seated it); never demote
//     it for being short.
// Pure; runs after enforceGeneratedPrimary and before allocate. One Short per concept
// at most, but generic over several lessons.
export function enforcePrimaryDurationFloor(
  lessons: ValidatedLesson[],
  opts: {
    durOf: (id: string) => number;
    roleOf: (id: string) => ConceptResourceRole | undefined;
    generatedIds: Set<string>;
    floorMin: number;
  },
): ValidatedLesson[] {
  const { durOf, roleOf, generatedIds, floorMin } = opts;
  return lessons.map((l) => {
    const primaryId = l.mandatoryResourceIds[0];
    if (!primaryId) return l;
    // Exempt authored on-ramps and any lead that already clears the floor.
    if (generatedIds.has(primaryId) || durOf(primaryId) >= floorMin) return l;
    // Best non-thin teacher from this lesson's own pools, mandatory tail before pool.
    const replacement = [...l.mandatoryResourceIds.slice(1), ...l.optionalResourceIds].find(
      (id) => roleOf(id) === ConceptResourceRole.teaches && durOf(id) >= floorMin,
    );
    if (!replacement) return l; // nothing better — keep the thin primary (≥1 guarantee)
    return {
      ...l,
      mandatoryResourceIds: [
        replacement,
        ...l.mandatoryResourceIds.slice(1).filter((id) => id !== replacement),
      ],
      // Demote the thin old lead to the front of the optional pool (a real, if thin,
      // supplement) and drop the promoted replacement from it.
      optionalResourceIds: [primaryId, ...l.optionalResourceIds.filter((id) => id !== replacement)],
    };
  });
}

export async function loadComposerMap(
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
            select: { id: true, title: true, type: true, difficulty: true, durationMin: true, origin: true, trustScore: true },
          },
        },
        // Stable DB pre-sort; the real ranking (coverage+trust+duration
        // selectionScore, free-beta A3) is applied in JS below.
        orderBy: { coverageScore: 'desc' },
      },
    },
  });

  const edges: OrderEdge[] = rows.flatMap((c) =>
    c.prereqsIn.map((e) => ({ fromSlug: e.from.slug, toSlug: c.slug })),
  );
  // Present concepts to the composer in continuity-first teaching order (each builds
  // on the previous), the same linearization validate-composition derives the final
  // lesson order from — so the composer's merge decisions key off real adjacency.
  const pos = new Map(continuityOrder(rows.map((r) => ({ slug: r.slug })), edges).map((s, i) => [s, i]));

  const concepts: ComposerInputConcept[] = rows
    .map((c) => ({
      slug: c.slug,
      title: c.title,
      membership: c.membership,
      prerequisiteSlugs: c.prereqsIn.map((e) => e.from.slug),
      // Free-beta A3: candidates ordered by the attach-time selection blend
      // (coverage+trust+duration), not raw coverage — so learner votes re-rank
      // persisted candidates at track build. Ordering only; primary floors and
      // admission stayed coverage-pure upstream.
      candidates: c.resources
        .map((r) => ({
          resourceId: r.resource.id,
          role: r.role,
          coverageScore: r.coverageScore,
          trustScore: r.resource.trustScore,
          title: r.resource.title,
          type: r.resource.type,
          difficulty: r.resource.difficulty,
          durationMin: r.resource.durationMin,
          isGenerated: r.resource.origin === 'generated',
        }))
        .sort((a, b) => selectionScore(b, false) - selectionScore(a, false)),
    }))
    .sort((a, b) => (pos.get(a.slug) ?? 0) - (pos.get(b.slug) ?? 0));

  return { concepts, edges };
}
