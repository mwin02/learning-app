// Pre-Freeze Map Review (Block 1) — the PURE core of the whole-map critic.
//
// reviewSpine (review-spine.ts) critiques the spine SKELETON at authoring time.
// It runs before three things that all land in the permanent, build-once Path and
// that it therefore structurally cannot see: frontier concepts (added after), the
// remediation splits splitConcept lands (the `views` triplication), and resources
// (it reasons over titles only, so it can't see a concept covered by a relaxed /
// low-coverage primary). This module reviews the FINAL assembled map at the
// `building → spine_ready` freeze boundary instead.
//
// Everything here is PURE (no DB, no LLM) so it unit-tests without secrets:
//   - detectHollowConcepts   — deterministic: a relaxed / low-coverage primary is
//                              a papered-over hole. No model judgment needed.
//   - detectDuplicationCandidates — the title/scope similarity heuristic that
//                              decides which concept pairs are even WORTH sending
//                              the critic (which then makes the precision call).
//   - normalizeLlmFindings   — validates/dedupes the model's raw findings.
//   - choosePrimary          — the concept's lead resource (loader helper).
// The LLM call + DB edges live in run-map-review.ts / path-review.ts.

import { ConceptMembership, ConceptResourceRole } from '@prisma/client';
import { MAP_HOLLOW_COVERAGE, MAP_DUP_CANDIDATE_SIMILARITY } from '@/lib/config';

// The map-review finding kinds — only what the spine-only critic can't produce.
export const MAP_REVIEW_FINDING_KINDS = ['duplication', 'hollow', 'granularity'] as const;
export type MapReviewFindingKind = (typeof MAP_REVIEW_FINDING_KINDS)[number];

// The subset the LLM owns: `hollow` is computed deterministically here, never asked
// of the model (it's a coverage threshold, not a judgment call).
export const MAP_REVIEW_LLM_KINDS = ['duplication', 'granularity'] as const;

export type MapReviewFinding = {
  kind: MapReviewFindingKind;
  // The concept slug(s) the finding implicates: two for `duplication`, one for
  // `hollow` / `granularity`.
  conceptSlugs: string[];
  // What's wrong and the concrete fix.
  message: string;
};

// A concept's chosen lead resource — the coverage-desc head of its `teaches`
// candidates (a relaxed concept may have only a sub-floor one). Absent when the
// concept has no resource at all (an unresourced frontier concept).
export type PrimaryResource = {
  title: string;
  role: ConceptResourceRole;
  coverageScore: number;
};

export type MapConcept = {
  slug: string;
  title: string;
  membership: ConceptMembership;
  primaryRelaxed: boolean;
  primary?: PrimaryResource;
};

export type MapEdge = { fromSlug: string; toSlug: string };

// The final assembled map — every concept (spine + frontier), every edge, each
// concept's chosen primary. The view reviewSpine cannot have.
export type AssembledMap = {
  topic: string;
  concepts: MapConcept[];
  edges: MapEdge[];
};

// ── hollow (deterministic) ──────────────────────────────────────────────────

// A concept is `hollow` when it is "covered" for readiness but only weakly: either
// remediation RELAXED the bar (accepted a sub-floor best-effort primary), or its
// chosen primary sits below MAP_HOLLOW_COVERAGE. A concept with NO primary at all is
// a spine hole (readiness's job), not a papered-over one — skip it.
export function detectHollowConcepts(
  concepts: MapConcept[],
  threshold: number = MAP_HOLLOW_COVERAGE,
): MapReviewFinding[] {
  const findings: MapReviewFinding[] = [];
  for (const c of concepts) {
    if (c.primaryRelaxed) {
      const detail = c.primary
        ? `("${c.primary.title}", coverage ${c.primary.coverageScore.toFixed(2)}, role ${c.primary.role})`
        : '(no qualifying teaches resource)';
      findings.push({
        kind: 'hollow',
        conceptSlugs: [c.slug],
        message: `Concept "${c.title}" (${c.slug}) rests on a RELAXED best-effort primary ${detail} — remediation could not source a resource clearing the coverage floor. Source a stronger teaching resource.`,
      });
      continue;
    }
    if (c.primary && c.primary.coverageScore < threshold) {
      findings.push({
        kind: 'hollow',
        conceptSlugs: [c.slug],
        message: `Concept "${c.title}" (${c.slug}) is covered only by a low-coverage primary ("${c.primary.title}", coverage ${c.primary.coverageScore.toFixed(2)} < ${threshold}) — a thin, papered-over hole. Source a resource that covers the concept more fully.`,
      });
    }
  }
  return findings;
}

// ── duplication candidates (heuristic pre-filter) ───────────────────────────

export type DuplicationCandidate = { a: string; b: string; similarity: number };

// Connective / generic-noise words stripped before comparing concept scope, so
// similarity keys on the meaningful nouns ("view", "join") not the packaging.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'from',
  'into', 'intro', 'introduction', 'overview', 'basic', 'fundamental', 'concept',
]);

// Naive singularization: trim a trailing plural `s` so "views"/"view" and
// "cases"/"case" collide. Guards the common false plurals (ss/us/is, short words).
function singularize(w: string): string {
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

// Lowercase → split on non-alphanumerics → singularize → drop stopwords + any
// caller-supplied stop tokens (the topic name, which is noise inside its own map).
export function normalizeTokens(text: string, extraStop: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const w = singularize(raw);
    if (w.length < 2 || STOPWORDS.has(w) || extraStop.has(w)) continue;
    out.add(w);
  }
  return out;
}

// The topic's own tokens are noise inside its map ("sql" in "SQL Views") — strip
// them so two concepts aren't judged similar merely for sharing the topic word.
function topicStopSet(topic: string): Set<string> {
  return new Set([...topic.toLowerCase().split(/[^a-z0-9]+/)].filter(Boolean).map(singularize));
}

// A concept's scope tokens = its title tokens ∪ its (de-kebabed) slug tokens.
function conceptTokens(c: { slug: string; title: string }, topicStop: Set<string>): Set<string> {
  const t = normalizeTokens(c.title, topicStop);
  for (const s of normalizeTokens(c.slug.replace(/-/g, ' '), topicStop)) t.add(s);
  return t;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Every concept PAIR whose scope-token Jaccard clears the (permissive) threshold —
// the pairs worth handing the critic to confirm/reject. Deliberately over-includes;
// the LLM makes the precision call. Sorted most-similar first (deterministic).
export function detectDuplicationCandidates(
  concepts: { slug: string; title: string }[],
  topic: string,
  threshold: number = MAP_DUP_CANDIDATE_SIMILARITY,
): DuplicationCandidate[] {
  const topicStop = topicStopSet(topic);
  const toks = concepts.map((c) => ({ slug: c.slug, tokens: conceptTokens(c, topicStop) }));
  const out: DuplicationCandidate[] = [];
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      const sim = jaccard(toks[i].tokens, toks[j].tokens);
      if (sim >= threshold) {
        out.push({ a: toks[i].slug, b: toks[j].slug, similarity: Math.round(sim * 100) / 100 });
      }
    }
  }
  out.sort((x, y) => y.similarity - x.similarity || `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`));
  return out;
}

// ── normalization / assembly ────────────────────────────────────────────────

// Validate + dedupe the model's raw findings: keep only the LLM-owned kinds, drop
// any referencing an unknown slug, require ≥2 concepts for a `duplication` and ≥1
// otherwise, and collapse duplicate (kind + concept-set) rows. Guards against a
// model that hallucinates a slug, emits `hollow` (ours to compute), or repeats.
export function normalizeLlmFindings(
  raw: { kind: string; conceptSlugs: string[]; message: string }[],
  validSlugs: Set<string>,
): MapReviewFinding[] {
  const llmKinds = MAP_REVIEW_LLM_KINDS as readonly string[];
  const out: MapReviewFinding[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (!llmKinds.includes(f.kind)) continue;
    const slugs = [...new Set(f.conceptSlugs)].filter((s) => validSlugs.has(s));
    if (f.kind === 'duplication' ? slugs.length < 2 : slugs.length === 0) continue;
    const message = f.message.trim();
    if (!message) continue;
    const key = `${f.kind}:${[...slugs].sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: f.kind as MapReviewFindingKind, conceptSlugs: slugs, message });
  }
  return out;
}

// Collapse exact-duplicate findings (same kind + same concept set) across the LLM
// and deterministic passes — one worklist row per real problem.
export function dedupeFindings(findings: MapReviewFinding[]): MapReviewFinding[] {
  const seen = new Set<string>();
  const out: MapReviewFinding[] = [];
  for (const f of findings) {
    const key = `${f.kind}:${[...f.conceptSlugs].sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// The concept's lead resource: the highest-coverage `teaches` candidate, or (for a
// relaxed concept whose best-effort primary is not a `teaches`) the highest-coverage
// candidate overall. Undefined when the concept has no candidate at all.
export function choosePrimary(
  candidates: { title: string; role: ConceptResourceRole; coverageScore: number }[],
): PrimaryResource | undefined {
  if (candidates.length === 0) return undefined;
  const teaches = candidates.filter((c) => c.role === ConceptResourceRole.teaches);
  const pool = teaches.length > 0 ? teaches : candidates;
  const best = pool.reduce((a, b) => (b.coverageScore > a.coverageScore ? b : a));
  return { title: best.title, role: best.role, coverageScore: best.coverageScore };
}
