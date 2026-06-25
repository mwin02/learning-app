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
} from '@/lib/config';
import { relatedTopics } from '@/types/resource';
import type { AuthoredConcept } from '@/lib/agents/map/cycle';
import type { OnTrace } from '@/lib/agents/agent-trace';

// Lever A — attachment hygiene. Given a concept's judged/attached candidates,
// return the subset worth keeping: drop below the coverage floor, then cap to the
// top MAP_MAX_CANDIDATES_PER_CONCEPT by coverage. The cap can never regress
// readiness — the best qualifying `teaches` (>= MAP_SPINE_MIN_PRIMARY_COVERAGE) is
// always retained, swapped in over the lowest-coverage kept item if the cap pushed
// it out. Pure + generic so it serves both the fresh judge output (attach-
// candidates / source-concept) and a re-cap over already-attached DB rows; tests
// without a DB. Input order is not assumed; output is coverage-desc.
export function selectAttachable<T extends { role: ConceptResourceRole; coverageScore: number }>(
  candidates: T[],
): T[] {
  const sorted = candidates
    .filter((c) => c.coverageScore >= MAP_ATTACH_MIN_COVERAGE)
    .sort((a, b) => b.coverageScore - a.coverageScore);
  const kept = sorted.slice(0, MAP_MAX_CANDIDATES_PER_CONCEPT);

  // Guarantee the single best qualifying primary survives the cap (it clears the
  // floor by construction; only the cap could evict it when many higher-coverage
  // uses/assesses crowd it out).
  const bestPrimary = sorted.find(
    (c) => c.role === ConceptResourceRole.teaches && c.coverageScore >= MAP_SPINE_MIN_PRIMARY_COVERAGE,
  );
  if (bestPrimary && !kept.includes(bestPrimary)) kept[kept.length - 1] = bestPrimary;
  return kept;
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
  const candidates = await searchResources({
    query: concept.title,
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
  });

  // Floor + cap (Lever A) instead of keeping everything > 0, so a generic concept
  // can't hoard the long tail of low-coverage / off-target search hits.
  const kept = selectAttachable(judged);

  return { conceptSlug: concept.slug, candidates: kept };
}
