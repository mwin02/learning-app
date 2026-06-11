// Phase 2.5e-2: deterministic re-validation of the composer's output — the cheap
// "critic" for the Track builder's hard invariants. No LLM. The composer
// (composer.ts) is judgment; this enforces structure so a model slip can never
// produce a broken Track:
//
//   - Concept coverage: every KEPT (non-pruned) concept lands in exactly one
//     lesson. A concept the composer forgot gets a synthesized lesson; a pruned
//     or unknown slug referenced by a lesson is dropped. A spine concept is never
//     lost (it can't be pruned away into a gap silently).
//   - Primary selection: each lesson's primary must be a real `teaches` candidate
//     of one of its concepts. The composer's pick is honored when valid; otherwise
//     we fall back to the highest-coverage `teaches` (then any role) in the pool.
//     This is the deterministic backstop for a dropped/invalid handle.
//   - Alternates: every other candidate of the lesson's concepts, coverage-desc,
//     deduped — the frozen runners-up (ROADMAP: alternates are a byproduct).
//   - Ordering: lesson order is DERIVED from the prereq DAG (topoSort), not trusted
//     from the model — a lesson comes after every prerequisite of every concept it
//     teaches. Composer order only breaks ties within a layer.
//
// Budget trimming is NOT here — that's plan.ts, run by the builder over these
// validated lessons.

import { ConceptResourceRole } from '@prisma/client';
import { topoSort, type OrderEdge } from '@/lib/agents/map/order';
import type {
  ComposerResult,
  ComposerInputConcept,
  ComposerCandidate,
} from '@/lib/agents/track/composer';

export type ValidatedLesson = {
  conceptSlugs: string[];
  primaryResourceId: string;
  // Frozen runners-up (every non-primary candidate of the lesson's concepts).
  alternateResourceIds: string[];
  title: string;
  summary: string;
  // A lesson is frontier only if ALL its concepts are frontier; any spine concept
  // makes it spine (never trimmed for budget).
  isFrontier: boolean;
  masteryRelevant: boolean;
  estMinutes: number;
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
}): ValidationOutput {
  const { composition, concepts, edges } = args;
  const warnings: string[] = [];

  const conceptBySlug = new Map(concepts.map((c) => [c.slug, c]));
  const pruned = new Set(composition.prune.filter((s) => conceptBySlug.has(s)));
  // A spine concept must never be pruned into a gap — keep it and warn.
  for (const slug of [...pruned]) {
    if (conceptBySlug.get(slug)!.membership === 'spine') {
      pruned.delete(slug);
      warnings.push(`refused to prune spine concept '${slug}' (kept to stay spine-complete)`);
    }
  }
  const keptSlugs = concepts.map((c) => c.slug).filter((s) => !pruned.has(s));

  // --- assign each kept concept to exactly one lesson group ---------------
  // Honor the composer's groupings (merges), dropping references to pruned/unknown
  // concepts and ignoring duplicates; then sweep any kept concept the composer
  // omitted into its own single-concept lesson so nothing is silently lost.
  const assigned = new Set<string>();
  type Group = {
    conceptSlugs: string[];
    title: string;
    summary: string;
    masteryRelevant: boolean;
    primaryResourceId: string | null;
  };
  const groups: Group[] = [];

  for (const l of composition.lessons) {
    const slugs = l.conceptSlugs.filter(
      (s) => conceptBySlug.has(s) && !pruned.has(s) && !assigned.has(s),
    );
    if (slugs.length === 0) continue; // wholly pruned/duplicate/unknown lesson
    slugs.forEach((s) => assigned.add(s));
    groups.push({
      conceptSlugs: slugs,
      title: l.title,
      summary: l.summary,
      masteryRelevant: l.masteryRelevant,
      primaryResourceId: l.primaryResourceId,
    });
  }

  for (const slug of keptSlugs) {
    if (assigned.has(slug)) continue;
    const c = conceptBySlug.get(slug)!;
    warnings.push(`composer omitted concept '${slug}'; synthesized a lesson for it`);
    groups.push({
      conceptSlugs: [slug],
      title: c.title,
      summary: `Learn ${c.title}.`,
      masteryRelevant: false,
      primaryResourceId: null,
    });
  }

  if (groups.length === 0) {
    throw new CompositionError('No lessons after validation (every concept pruned or unknown).');
  }

  // --- resolve primary + alternates per group ----------------------------
  const lessonsUnordered = groups.map((g) => {
    const pool = poolFor(g.conceptSlugs, conceptBySlug);
    const primary = choosePrimary(g.primaryResourceId, pool);
    if (!primary) {
      // spine_ready guarantees a teaches per spine concept, so this implies a
      // frontier (or thin) concept with zero candidates — surface it loudly.
      throw new CompositionError(
        `No usable resource for lesson [${g.conceptSlugs.join(', ')}] — cannot pick a primary.`,
      );
    }
    if (g.primaryResourceId && g.primaryResourceId !== primary.resourceId) {
      warnings.push(
        `lesson [${g.conceptSlugs.join(', ')}]: composer primary invalid/absent, fell back to top candidate`,
      );
    }
    const alternateResourceIds = dedupeAlternates(pool, primary.resourceId);
    const isFrontier = g.conceptSlugs.every(
      (s) => conceptBySlug.get(s)!.membership === 'frontier',
    );
    return {
      conceptSlugs: g.conceptSlugs,
      primaryResourceId: primary.resourceId,
      alternateResourceIds,
      title: g.title,
      summary: g.summary,
      isFrontier,
      masteryRelevant: isFrontier ? g.masteryRelevant : false,
      estMinutes: primary.durationMin,
    };
  });

  // --- order lessons by the DAG, not by the model ------------------------
  const rank = new Map<string, number>();
  topoSort(
    keptSlugs.map((slug) => ({ slug })),
    edges.filter((e) => !pruned.has(e.fromSlug) && !pruned.has(e.toSlug)),
  ).forEach((slug, i) => rank.set(slug, i));
  // A lesson's position = the latest topo rank among its concepts (so a merged
  // lesson follows every prerequisite of every concept it teaches). Ties keep the
  // composer's original order (stable sort over the as-built array index).
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

// Honor the composer's primary when it's a valid `teaches` in the pool; else the
// highest-coverage `teaches`; else the highest-coverage candidate of any role.
function choosePrimary(
  composerPick: string | null,
  pool: ComposerCandidate[],
): ComposerCandidate | null {
  if (pool.length === 0) return null;
  const teaches = pool
    .filter((c) => c.role === ConceptResourceRole.teaches)
    .sort((a, b) => b.coverageScore - a.coverageScore);
  if (composerPick) {
    const picked = teaches.find((c) => c.resourceId === composerPick);
    if (picked) return picked;
  }
  if (teaches.length > 0) return teaches[0];
  return [...pool].sort((a, b) => b.coverageScore - a.coverageScore)[0];
}

// Every non-primary candidate, coverage-desc, deduped by resourceId (a resource
// can be a candidate of two merged concepts).
function dedupeAlternates(pool: ComposerCandidate[], primaryId: string): string[] {
  const seen = new Set<string>([primaryId]);
  const out: string[] = [];
  for (const c of [...pool].sort((a, b) => b.coverageScore - a.coverageScore)) {
    if (seen.has(c.resourceId)) continue;
    seen.add(c.resourceId);
    out.push(c.resourceId);
  }
  return out;
}
