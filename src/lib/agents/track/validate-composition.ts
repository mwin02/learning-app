// Phase 2.5e-2 / 2.5e-2b: deterministic re-validation of the composer's output —
// the cheap "critic" for the Track builder's hard invariants. No LLM. The composer
// (composer.ts) is judgment; this enforces structure so a model slip can never
// produce a broken Track:
//
//   - Inclusion closure (2.5e-2b): the included concept set must be downward-closed
//     over its NON-PRUNED prerequisites. Spine is included by default; the composer
//     may omit deep, non-load-bearing frontier (that is how target mastery sets
//     depth) and may PRUNE a known spine concept (2.5e-5) — but any concept an
//     included concept DEPENDS ON is pulled back in. This handles
//     frontier→spine edges (possible via manual map edits) and frontier→frontier
//     prereq chains: a load-bearing frontier is never silently excluded. Pruning is
//     the one legal way to break a prereq (the learner already knows it).
//   - Resource grading (2.5e-7b): the composer grades each lesson's candidates into
//     a ranked MANDATORY complementary core + an OPTIONAL pool. Here we keep only the
//     ids that are real candidates of the lesson's (surviving) concepts, dedupe, and
//     guarantee ≥1 mandatory — falling back to the highest-coverage `teaches` (then
//     any role) when the composer's core is empty/invalid. Every remaining pool
//     candidate is frozen into `optional` (the substitute/invalidation pool), so no
//     runner-up is lost. Depth (how many mandatory become primaries) + budget are the
//     allocator's job (allocate.ts), not this module's.
//   - Ordering: lesson order is DERIVED from the prereq DAG (continuityOrder), not
//     trusted from the model — a lesson comes after every prerequisite of every
//     concept it teaches, AND consecutive lessons stay connected (each builds on the
//     last) rather than fanning out breadth-first. The model doesn't sequence within
//     a thread; at branch points (independent threads both ready) the composer's
//     emission order breaks the tie — which thread to teach first — and is consulted
//     ONLY there (see composer.ts).
//
// Budget trimming + depth allocation are NOT here — that's allocate.ts, run by the
// builder over these validated lessons (closure-aware breadth at floor cost).

import { ConceptResourceRole } from '@prisma/client';
import type { OrderEdge } from '@/lib/agents/map/order';
import type { TimeWeight } from '@/lib/agents/track/allocate';
import {
  buildPrereqIndex,
  computeInclusion,
  assignConceptsToLessons,
  orderConceptSlugs,
} from '@/lib/agents/track/composition-core';
import type {
  ComposerResult,
  ComposerInputConcept,
  ComposerCandidate,
} from '@/lib/agents/track/composer';

export type ValidatedLesson = {
  conceptSlugs: string[];
  // Coarse time-priority bucket, carried through from the composer (allocator input).
  timeWeight: TimeWeight;
  // Ranked mandatory complementary core (≥1) — the must-have resources, best first.
  mandatoryResourceIds: string[];
  // Frozen optional/substitute pool: composer's graded optionals first, then every
  // remaining candidate of the lesson's concepts (coverage-desc), deduped.
  optionalResourceIds: string[];
  title: string;
  summary: string;
  // A lesson is frontier only if ALL its concepts are frontier; any spine concept
  // makes it spine (never trimmed for budget).
  isFrontier: boolean;
  masteryRelevant: boolean;
};

export type ValidationOutput = {
  lessons: ValidatedLesson[];
  // Non-fatal repairs made to the composer's output, for the trace/diagnostics.
  warnings: string[];
};

export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionError';
  }
}

export function validateComposition(args: {
  composition: ComposerResult;
  concepts: ComposerInputConcept[];
  edges: OrderEdge[];
  // 2.5e-8 block 2c: when true, a lesson MAY keep an explicitly-graded resource that
  // belongs to a different concept in the Path (the composer agent's Tier-1 "re-purpose
  // across concepts" — e.g. an exam-style `assesses` attached elsewhere). The fallback
  // and substitute pool stay scoped to the lesson's own concepts. Off by default so the
  // single-pass composer's resolution is byte-for-byte unchanged.
  crossConceptResources?: boolean;
}): ValidationOutput {
  const { composition, concepts, edges, crossConceptResources = false } = args;
  const warnings: string[] = [];
  // The accept-set for explicitly-graded mandatory/optional ids: the whole-Path candidate
  // pool when cross-concept is allowed, else undefined (resolveResources falls back to the
  // lesson's own pool — today's behavior).
  const acceptIds = crossConceptResources
    ? new Set(concepts.flatMap((c) => c.candidates.map((cand) => cand.resourceId)))
    : undefined;

  const conceptBySlug = new Map(concepts.map((c) => [c.slug, c]));
  // Spine pruning is allowed (2.5e-5): a learner who already knows a backbone
  // concept can drop it. Closure makes this safe — a pruned concept is excluded
  // from the seed set and skipped in the prereq walk, so it is never re-added, and
  // a dependent's prereq is considered satisfied by the learner's knowledge. The
  // composer (composer.ts) is told to prune spine only with clear evidence.
  //
  // Intent-driven omission (2.5e-8) is the same exclusion with a different
  // justification: `omitForIntent` drops introductory/foundational concepts the
  // inferred intent makes unnecessary (cram/review), without an explicit
  // prior-knowledge statement naming them. Structurally identical to prune — folded
  // into the same excluded set — so a kept concept's prereq edge onto an omitted one
  // is considered satisfied and the omitted concept is never re-seeded.
  const pruned = new Set(
    [
      ...composition.prune,
      ...composition.omitForIntent.map((o) => o.conceptSlug),
    ].filter((s) => conceptBySlug.has(s)),
  );
  // Surface each intent-driven omission for the trace — these are not learner-stated
  // (unlike prune), so they warrant a visible record for build review.
  for (const o of composition.omitForIntent) {
    if (!conceptBySlug.has(o.conceptSlug)) continue;
    const m = conceptBySlug.get(o.conceptSlug)!.membership;
    warnings.push(`omitted ${m} concept '${o.conceptSlug}' for intent: ${o.reason}`);
  }

  // --- inclusion closure -------------------------------------------------
  // Seeds: every spine concept (always taught) + every concept the composer put
  // in a lesson. Then close over non-pruned prerequisites so nothing included is
  // left depending on an excluded concept.
  const prereqsOf = buildPrereqIndex(
    concepts.map((c) => c.slug),
    edges,
  );

  const composerSlugs = new Set<string>();
  for (const l of composition.lessons) {
    for (const s of l.conceptSlugs) {
      if (conceptBySlug.has(s) && !pruned.has(s)) composerSlugs.add(s);
    }
  }
  const seeds = [
    ...concepts.filter((c) => c.membership === 'spine' && !pruned.has(c.slug)).map((c) => c.slug),
    ...composerSlugs,
  ];
  const included = computeInclusion({ prereqsOf, excluded: pruned, seeds });
  // Frontier the composer excluded that got pulled back as a prerequisite — note it.
  for (const s of included) {
    if (!composerSlugs.has(s) && conceptBySlug.get(s)!.membership === 'frontier') {
      warnings.push(`frontier concept '${s}' re-included as a prerequisite of an included concept`);
    }
  }

  // --- assign each included concept to exactly one lesson ----------------
  // Honor the composer's groupings (merges), dropping references to pruned/unknown/
  // excluded concepts and ignoring duplicates; then sweep any included concept the
  // composer omitted (a forgotten spine, or a closure-forced frontier) into its own
  // single-concept lesson so nothing included is silently lost.
  const groups = assignConceptsToLessons({
    lessons: composition.lessons,
    included,
    concepts,
    warnings,
  });

  if (groups.length === 0) {
    throw new CompositionError(
      'No lessons after validation — every concept was pruned (the learner may already know this whole topic) or unknown.',
    );
  }

  // --- resolve mandatory core + optional pool per group ------------------
  const lessonsUnordered = groups.map((g) => {
    const pool = poolFor(g.conceptSlugs, conceptBySlug);
    const { mandatoryResourceIds, optionalResourceIds } = resolveResources(g, pool, warnings, acceptIds);
    const isFrontier = g.conceptSlugs.every(
      (s) => conceptBySlug.get(s)!.membership === 'frontier',
    );
    return {
      conceptSlugs: g.conceptSlugs,
      timeWeight: g.timeWeight,
      mandatoryResourceIds,
      optionalResourceIds,
      title: g.title,
      summary: g.summary,
      isFrontier,
      masteryRelevant: isFrontier ? g.masteryRelevant : false,
    };
  });

  // --- order lessons: continuity-first DAG, composer breaks thread ties ---
  // The teaching order is derived deterministically by continuityOrder: it keeps
  // each topic thread contiguous (consecutive lessons build on each other, not a
  // breadth-first fan-out) and never places a concept before a prerequisite. The
  // composer does NOT sequence within a thread — but at BRANCH POINTS, where two
  // independent threads are both ready, the DAG leaves the order open, and there the
  // composer's emission order decides which thread to pursue first (its conventional-
  // teaching-order judgment — e.g. differentiation before integration before series).
  // We derive that preference from the order concepts first appear across the
  // composer's lessons and pass it as continuityOrder's tie-break, where it is only
  // ever consulted at those fork points. Unranked slugs (closure-pulled, not emitted)
  // fall back to lexical, last — a model slip can never violate a prerequisite.
  const composerPriority = new Map<string, number>();
  for (const l of composition.lessons) {
    for (const s of l.conceptSlugs) {
      if (included.has(s) && !composerPriority.has(s)) composerPriority.set(s, composerPriority.size);
    }
  }
  const includedSlugs = [...included];
  const rank = new Map<string, number>();
  orderConceptSlugs(includedSlugs, edges, composerPriority).forEach((slug, i) => rank.set(slug, i));
  // A lesson's position = the latest order rank among its concepts (so a merged
  // lesson follows every prerequisite of every concept it teaches). Ranks are
  // unique, so ties are rare; the as-built index is a deterministic fallback.
  const lessons = lessonsUnordered
    .map((lesson, idx) => ({
      lesson,
      key: Math.max(...lesson.conceptSlugs.map((s) => rank.get(s) ?? 0)),
      idx,
    }))
    .sort((a, b) => a.key - b.key || a.idx - b.idx)
    .map((x) => x.lesson);

  return { lessons, warnings };
}

// All candidates across a group's concepts (a merged lesson draws on all of them).
function poolFor(
  conceptSlugs: string[],
  conceptBySlug: Map<string, ComposerInputConcept>,
): ComposerCandidate[] {
  return conceptSlugs.flatMap((s) => conceptBySlug.get(s)?.candidates ?? []);
}

// Turn a group's composer-graded lists into validated mandatory + optional id lists:
//   - mandatory = the composer's core, kept only where it's a real pool candidate,
//     deduped. Empty/all-invalid → fall back to one top candidate (≥1 guarantee).
//   - optional  = the composer's optionals (real, non-mandatory), then EVERY other
//     pool candidate (coverage-desc) — so all runners-up stay frozen as substitutes.
function resolveResources(
  g: { conceptSlugs: string[]; mandatoryResourceIds: string[]; optionalResourceIds: string[] },
  pool: ComposerCandidate[],
  warnings: string[],
  // Accept-set for explicitly-graded ids. Defaults to the lesson's own pool (today);
  // the agent passes the whole-Path pool so a borrowed cross-concept resource survives.
  acceptIds?: Set<string>,
): { mandatoryResourceIds: string[]; optionalResourceIds: string[] } {
  const inPool = new Set(pool.map((c) => c.resourceId));
  const accept = acceptIds ?? inPool;
  const dedupe = (ids: string[], exclude: Set<string> = new Set()): string[] => {
    const seen = new Set(exclude);
    const out: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };

  let mandatory = dedupe(g.mandatoryResourceIds.filter((id) => accept.has(id)));
  if (mandatory.length === 0) {
    const fb = chooseFallback(pool);
    if (!fb) {
      // spine_ready guarantees a teaches per spine concept, so this implies a
      // frontier (or thin) concept with zero candidates — surface it loudly.
      throw new CompositionError(
        `No usable resource for lesson [${g.conceptSlugs.join(', ')}] — cannot pick a primary.`,
      );
    }
    mandatory = [fb.resourceId];
    // Only a real fallback (composer DID grade a core, but none survived) is worth a
    // warning; a synthesized lesson's empty core is already noted upstream.
    if (g.mandatoryResourceIds.length > 0) {
      warnings.push(
        `lesson [${g.conceptSlugs.join(', ')}]: composer mandatory invalid/absent, fell back to top candidate`,
      );
    }
  }

  const mandatorySet = new Set(mandatory);
  const optional = dedupe(g.optionalResourceIds.filter((id) => accept.has(id)), mandatorySet);
  // Freeze every remaining candidate as a substitute, highest coverage first.
  const taken = new Set([...mandatory, ...optional]);
  for (const cand of [...pool].sort((a, b) => b.coverageScore - a.coverageScore)) {
    if (taken.has(cand.resourceId)) continue;
    taken.add(cand.resourceId);
    optional.push(cand.resourceId);
  }
  return { mandatoryResourceIds: mandatory, optionalResourceIds: optional };
}

// Highest-coverage `teaches`; else the highest-coverage candidate of any role.
function chooseFallback(pool: ComposerCandidate[]): ComposerCandidate | null {
  if (pool.length === 0) return null;
  const teaches = pool
    .filter((c) => c.role === ConceptResourceRole.teaches)
    .sort((a, b) => b.coverageScore - a.coverageScore);
  if (teaches.length > 0) return teaches[0];
  return [...pool].sort((a, b) => b.coverageScore - a.coverageScore)[0];
}
