// Phase 2.5d-2: the candidate judge — scores one spine concept's candidate
// resources for how they serve that concept.
//
// searchResources ranks resources by semantic proximity to a concept's title,
// but proximity isn't pedagogy: a nearby resource might teach the concept, merely
// use it in passing, or assess it — and might cover it fully or barely. This LLM
// pass turns a ranked candidate list into typed, scored ConceptResource links so
// the Track builder (2.5e) can pick a `teaches` primary by coverage and freeze
// the rest as alternates.
//
// Anti-hallucination: candidates are presented by opaque per-call handle (r1, r2,
// …); the model scores handles, and any handle it didn't receive is dropped (one
// bad id must not corrupt or fail the whole map build). This mirrors the AR
// retrieval/select handle indirection.

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { ConceptResourceRole } from '@prisma/client';
import { getModel } from '@/lib/ai/models';
import type { SearchResult } from '@/lib/agents/tools/search-resources';

export type JudgedCandidate = {
  resourceId: string;
  role: ConceptResourceRole;
  // 0–1: how completely the resource serves the concept in its assigned role.
  // The caller drops <= 0 (the judge's "not actually relevant" signal).
  coverageScore: number;
};

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      handle: z.string().min(1),
      role: z.nativeEnum(ConceptResourceRole),
      coverageScore: z.number().min(0).max(1),
    }),
  ),
});

// Judge one concept's candidates. Returns a verdict per resolvable candidate the
// model scored; the caller filters/sorts. Order is not guaranteed here.
export async function judgeCandidates(args: {
  conceptTitle: string;
  conceptSlug: string;
  candidates: SearchResult[];
}): Promise<JudgedCandidate[]> {
  const { conceptTitle, conceptSlug, candidates } = args;
  if (candidates.length === 0) return [];

  // Stable handle ↔ resource map for this call only.
  const byHandle = new Map<string, SearchResult>();
  candidates.forEach((c, i) => byHandle.set(`r${i + 1}`, c));

  const { model, temperature, maxOutputTokens, modelId } = getModel('mapCandidateJudge');
  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: VerdictSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(conceptTitle, byHandle),
  });

  // TODO(observability): fold into the structured logger (see curriculum-agent.ts).
  console.log('[map-candidate-judge]', {
    concept: conceptSlug,
    modelId,
    candidates: candidates.length,
    verdicts: result.experimental_output.verdicts.length,
    usage: result.usage,
    finishReason: result.finishReason,
  });

  // Dedupe by resourceId: if the model scores the same handle (hence the same
  // resource) more than once, keep the higher-coverage verdict. ConceptResource
  // is unique per (conceptId, resourceId), so a duplicate slipping through here
  // would become a unique-constraint violation when 2.5d-3 persists the rows.
  const byResource = new Map<string, JudgedCandidate>();
  for (const v of result.experimental_output.verdicts) {
    const row = byHandle.get(v.handle);
    if (!row) {
      // Fabricated/duplicate handle — drop it rather than fail the build.
      console.warn('[map-candidate-judge] unknown handle dropped', {
        concept: conceptSlug,
        handle: v.handle,
      });
      continue;
    }
    const existing = byResource.get(row.id);
    if (existing) {
      console.warn('[map-candidate-judge] duplicate resource verdict, keeping higher coverage', {
        concept: conceptSlug,
        resourceId: row.id,
      });
      if (v.coverageScore <= existing.coverageScore) continue;
    }
    byResource.set(row.id, { resourceId: row.id, role: v.role, coverageScore: v.coverageScore });
  }
  return [...byResource.values()];
}

const SYSTEM_PROMPT = `You score candidate learning resources for how they serve a single target concept in a curriculum map.

For each candidate, assign:
- \`role\`:
  - "teaches" — the resource directly teaches the target concept as a primary subject, from the ground up.
  - "uses" — the resource applies or assumes the concept but does not teach it (the concept is a prerequisite, not the lesson).
  - "assesses" — the resource is primarily practice/assessment for the concept (exercises, problem sets, quizzes).
- \`coverageScore\` (0.0–1.0) — how completely the resource serves the concept IN THAT ROLE. 1.0 = comprehensive and on-target; ~0.5 = partial or tangential; 0.0 = not actually about this concept (a search false-positive). Use 0.0 to reject a candidate that does not belong on this concept.

Rules:
- Judge ONLY against the candidate's provided metadata (title, summary, conceptsTaught, prerequisiteConcepts, type, difficulty). Do not invent facts about a resource.
- Reference each candidate by its \`handle\` exactly as given. Score every candidate you are given, once each. Never invent a handle.
- Be discriminating: a resource that merely mentions the concept is "uses" with low coverage, not "teaches".`;

function buildPrompt(conceptTitle: string, byHandle: Map<string, SearchResult>): string {
  const list = [...byHandle.entries()].map(([handle, r]) => ({
    handle,
    title: r.title,
    type: r.type,
    difficulty: r.difficulty,
    summary: r.summary,
    conceptsTaught: r.conceptsTaught,
    prerequisiteConcepts: r.prerequisiteConcepts,
  }));
  return [
    `Target concept: ${conceptTitle}`,
    '',
    'Candidates:',
    JSON.stringify(list, null, 2),
  ].join('\n');
}
