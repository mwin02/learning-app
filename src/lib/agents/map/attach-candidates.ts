// Phase 2.5d-2: candidate attachment — turns a validated spine (2.5d-1) into a
// per-concept plan of scored, typed ConceptResource links.
//
// For each spine concept: search the topic's pickable library for the closest
// resources (search-resources hybrid), then have the judge (candidate-judge.ts)
// assign each a role + coverageScore. The result is an in-memory plan; writing it
// as ConceptResource rows is 2.5d-3. A concept that turns up no usable candidate
// yields an empty attachment — the spine-hole signal the persistence block and
// the async thickener (2.5f) act on, not an error here.

import { ConceptResourceRole } from '@prisma/client';
import { searchResources } from '@/lib/agents/tools/search-resources';
import { judgeCandidates, type JudgedCandidate } from '@/lib/agents/map/candidate-judge';
import {
  MAP_CANDIDATES_PER_CONCEPT,
  MAP_JUDGE_CONCURRENCY,
  MAP_ATTACH_MIN_COVERAGE,
  MAP_MAX_CANDIDATES_PER_CONCEPT,
  MAP_SPINE_MIN_PRIMARY_COVERAGE,
  TRUST_SELECTION_WEIGHT,
} from '@/lib/config';
import { relatedTopics } from '@/types/resource';
import type { AuthoredConcept } from '@/lib/agents/map/cycle';
import type { OnTrace } from '@/lib/agents/agent-trace';

// Phase 2.5h: ranking score = coverage gated, trust ordering. coverageScore decides
// relevance; trustScore (when carried — fresh judge output) breaks ties so a higher-
// trust resource ranks above an equally-relevant lower-trust one. Rows without a
// trustScore (e.g. the re-cap over DB links in source-concept) fall back to pure
// coverage, preserving prior behavior there.
function selectionScore(c: { coverageScore: number; trustScore?: number }): number {
  if (c.trustScore == null) return c.coverageScore;
  return (1 - TRUST_SELECTION_WEIGHT) * c.coverageScore + TRUST_SELECTION_WEIGHT * c.trustScore;
}

// Lever A — count bound only. Given a candidate set, keep the top
// MAP_MAX_CANDIDATES_PER_CONCEPT by the coverage+trust selection score, always
// retaining the single best qualifying `teaches` (>= MAP_SPINE_MIN_PRIMARY_COVERAGE,
// a COVERAGE gate — trust never qualifies a primary) — swapped in over the lowest-
// ranked kept item if the cap pushed it out — so capping can never evict a concept's
// qualifying primary. Deliberately applies NO coverage floor: it bounds regrowth over
// an ALREADY-ADMITTED set (e.g. the merged DB rows in source-concept) without
// re-litigating admission, so it can only ever drop the lowest-ranked EXCESS beyond
// the cap and never empties a non-empty input. Pure; input order is not assumed;
// output is selection-score-desc (== coverage-desc when no trust is carried).
export function capCandidates<T extends { role: ConceptResourceRole; coverageScore: number; trustScore?: number }>(
  candidates: T[],
): T[] {
  const sorted = [...candidates].sort((a, b) => selectionScore(b) - selectionScore(a));
  const kept = sorted.slice(0, MAP_MAX_CANDIDATES_PER_CONCEPT);

  // Guarantee the single best qualifying primary survives the cap (only the cap
  // could evict it when many higher-ranked uses/assesses crowd it out). "Best" here
  // is by the same selection score, among `teaches` clearing the COVERAGE floor.
  const bestPrimary = sorted.find(
    (c) => c.role === ConceptResourceRole.teaches && c.coverageScore >= MAP_SPINE_MIN_PRIMARY_COVERAGE,
  );
  if (bestPrimary && !kept.includes(bestPrimary)) kept[kept.length - 1] = bestPrimary;
  return kept;
}

// Lever A — admission filter for FRESH judge output. Drops candidates below the
// coverage floor (MAP_ATTACH_MIN_COVERAGE), then count-bounds via capCandidates.
// The floor is an ADMISSION policy — "is this freshly-judged candidate good enough
// to attach?" — so it belongs only on newly-judged sets, never on a re-cap of rows
// already in the DB (those were admitted under whatever policy applied then, incl.
// 2.5f relaxed readiness; re-flooring them can wrongly delete a relaxed concept's
// only candidates and regress the Path). For the persisted re-cap use capCandidates.
// Pure + generic; tests without a DB. Output is selection-score-desc (the floor is
// still a pure COVERAGE gate — trust never admits a sub-floor candidate).
export function selectAttachable<T extends { role: ConceptResourceRole; coverageScore: number; trustScore?: number }>(
  candidates: T[],
): T[] {
  return capCandidates(candidates.filter((c) => c.coverageScore >= MAP_ATTACH_MIN_COVERAGE));
}

export type ConceptAttachment = {
  conceptSlug: string;
  // Judged candidates with coverageScore > 0, sorted coverage-desc so the Track
  // builder can take the head as primary. Empty = spine hole (no usable resource).
  candidates: JudgedCandidate[];
  // Phase 2.5f: when remediation could not source a qualifying `teaches` and
  // accepted the best sub-floor candidate as a best-effort primary, readiness
  // treats this concept as covered (not a hole) provided it has any candidate.
  // Absent/false on a freshly-built map (set only by remediation, 2.5f-3b).
  primaryRelaxed?: boolean;
};

export async function attachCandidates(args: {
  topic: string;
  concepts: AuthoredConcept[];
  onTrace?: OnTrace;
}): Promise<ConceptAttachment[]> {
  const { topic, concepts, onTrace = () => {} } = args;
  // Search the topic ∪ its related topics (e.g. a javascript-react map draws on
  // javascript foundations), mirroring AR retrieval. A topic with no relations
  // is just itself.
  const topics = relatedTopics(topic);
  onTrace({
    kind: 'stage',
    label: 'candidate attachment started',
    detail: { concepts: concepts.length, topics },
  });

  // Fan out per concept, bounded — each concept is one independent search + judge.
  const attachments: ConceptAttachment[] = [];
  for (let i = 0; i < concepts.length; i += MAP_JUDGE_CONCURRENCY) {
    const chunk = concepts.slice(i, i + MAP_JUDGE_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((c) => attachOneWithRetry(topics, c, onTrace)));
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') {
        attachments.push(s.value);
        return;
      }
      // Backstop: attachOneWithRetry catches its own failures and degrades to an
      // empty attachment, so this branch should be unreachable — but we never let
      // one concept's rejection fail the whole batch.
      const concept = chunk[j];
      console.error('[map-attach] concept attachment rejected after retry', {
        concept: concept.slug,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
      attachments.push({ conceptSlug: concept.slug, candidates: [] });
    });
  }

  const holes = attachments.filter((a) => a.candidates.length === 0).map((a) => a.conceptSlug);
  onTrace({
    kind: 'stage',
    label: 'candidate attachment done',
    detail: {
      concepts: attachments.length,
      withCandidates: attachments.length - holes.length,
      spineHoles: holes,
    },
  });
  return attachments;
}

// Run attachOne, retrying once on a thrown failure (transient Vertex error, or
// the judge capping mid-JSON so Output.object can't parse). If it still fails,
// degrade to an empty attachment so one flaky concept never aborts the whole map.
//
// TODO(2.5d-3+): surface a post-retry failure as a DISTINCT signal (e.g. an
// `error` field on ConceptAttachment) instead of collapsing it into the
// empty-candidates spine-hole bucket. As written, a transient judge/search
// failure is indistinguishable from a genuine library gap, so persistence and
// the async thickener can't tell "no good resource exists" from "the call broke".
async function attachOneWithRetry(
  topics: string[],
  concept: AuthoredConcept,
  onTrace: OnTrace,
): Promise<ConceptAttachment> {
  try {
    return await attachOne(topics, concept, onTrace);
  } catch (err) {
    console.warn('[map-attach] concept attachment failed, retrying once', {
      concept: concept.slug,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return await attachOne(topics, concept, onTrace);
    } catch (err2) {
      console.error('[map-attach] concept attachment failed after retry; treating as spine hole', {
        concept: concept.slug,
        error: err2 instanceof Error ? err2.message : String(err2),
      });
      return { conceptSlug: concept.slug, candidates: [] };
    }
  }
}

async function attachOne(
  topics: string[],
  concept: AuthoredConcept,
  onTrace: OnTrace,
): Promise<ConceptAttachment> {
  // Pickable == active + atomic (per ROADMAP: candidates are existing pickable
  // rows). pending_review is excluded — the spine is the gating backbone and
  // shouldn't rest on unvetted rows.
  //
  // Lever C: the on-ramp's bare title ("Introduction to Calculus") is a magnet —
  // searched against a single-subject corpus it ranks the whole subject. Query it
  // with orientation/setup wording instead, so the vector search leans toward
  // overview/getting-started resources rather than deep subject content.
  const query = concept.isOnRamp ? onRampQuery(concept.title) : concept.title;
  const candidates = await searchResources({
    query,
    topics,
    statuses: ['active'],
    pickableOnly: true,
    limit: MAP_CANDIDATES_PER_CONCEPT,
  });

  onTrace({
    kind: 'tool',
    label: 'searchResources',
    detail: { concept: concept.slug, found: candidates.length },
  });

  if (candidates.length === 0) {
    return { conceptSlug: concept.slug, candidates: [] };
  }

  const judged = await judgeCandidates({
    conceptTitle: concept.title,
    conceptSlug: concept.slug,
    candidates,
    isOnRamp: concept.isOnRamp ?? false,
  });

  // Floor + cap (Lever A) instead of keeping everything > 0, so a generic concept
  // can't hoard the long tail of low-coverage / off-target search hits.
  const kept = selectAttachable(judged);

  return { conceptSlug: concept.slug, candidates: kept };
}

// The discriminating embedding query for an on-ramp concept (Lever C). Augments
// the concept title with orientation/setup wording so the vector search ranks
// overview/getting-started resources over the subject's deep content. Subject-
// agnostic phrasing — works for both programming ("setup, first steps") and math
// ("big picture, notation, prerequisites"); the judge's on-ramp rubric is the
// hard filter, this just improves what the search surfaces to it.
export function onRampQuery(conceptTitle: string): string {
  return `${conceptTitle}: overview and getting started for an absolute beginner — what it is, the core idea and big picture, notation and setup, prerequisites, and the very first steps`;
}
