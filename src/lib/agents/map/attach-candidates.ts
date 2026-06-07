// Phase 2.5d-2: candidate attachment — turns a validated spine (2.5d-1) into a
// per-concept plan of scored, typed ConceptResource links.
//
// For each spine concept: search the topic's pickable library for the closest
// resources (search-resources hybrid), then have the judge (candidate-judge.ts)
// assign each a role + coverageScore. The result is an in-memory plan; writing it
// as ConceptResource rows is 2.5d-3. A concept that turns up no usable candidate
// yields an empty attachment — the spine-hole signal the persistence block and
// the async thickener (2.5j) act on, not an error here.

import { searchResources } from '@/lib/agents/tools/search-resources';
import { judgeCandidates, type JudgedCandidate } from '@/lib/agents/map/candidate-judge';
import { MAP_CANDIDATES_PER_CONCEPT, MAP_JUDGE_CONCURRENCY } from '@/lib/config';
import type { AuthoredConcept } from '@/lib/agents/map/cycle';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type ConceptAttachment = {
  conceptSlug: string;
  // Judged candidates with coverageScore > 0, sorted coverage-desc so the Track
  // builder can take the head as primary. Empty = spine hole (no usable resource).
  candidates: JudgedCandidate[];
};

export async function attachCandidates(args: {
  topic: string;
  concepts: AuthoredConcept[];
  onTrace?: OnTrace;
}): Promise<ConceptAttachment[]> {
  const { topic, concepts, onTrace = () => {} } = args;
  onTrace({ kind: 'stage', label: 'candidate attachment started', detail: { concepts: concepts.length } });

  // Fan out per concept, bounded — each concept is one independent search + judge.
  const attachments: ConceptAttachment[] = [];
  for (let i = 0; i < concepts.length; i += MAP_JUDGE_CONCURRENCY) {
    const chunk = concepts.slice(i, i + MAP_JUDGE_CONCURRENCY);
    const settled = await Promise.all(chunk.map((c) => attachOne(topic, c, onTrace)));
    attachments.push(...settled);
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

async function attachOne(
  topic: string,
  concept: AuthoredConcept,
  onTrace: OnTrace,
): Promise<ConceptAttachment> {
  // Pickable == active + atomic (per ROADMAP: candidates are existing pickable
  // rows). pending_review is excluded — the spine is the gating backbone and
  // shouldn't rest on unvetted rows.
  const candidates = await searchResources({
    query: concept.title,
    topic,
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

  const kept = judged
    .filter((j) => j.coverageScore > 0)
    .sort((a, b) => b.coverageScore - a.coverageScore);

  return { conceptSlug: concept.slug, candidates: kept };
}
