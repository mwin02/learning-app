// Pre-Freeze Map Review (Block 1) — the LLM orchestrator: one critic call per
// freeze, combined with the deterministic hollow pass.
//
// reviewMap runs the deterministic detectors (hollow, duplication candidates) from
// review-map.ts, hands the assembled map + the candidate pairs to a Flash critic
// that confirms/rejects `duplication` and flags `granularity` over the split-in /
// assembled nodes reviewSpine never saw, then merges the model's findings with the
// deterministic hollow findings. FAIL-OPEN: a thrown critic call degrades to the
// deterministic findings only (never fails the freeze) — the same posture as
// buildSpine's reviewSpine. No DB writes here (path-review.ts persists).

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';
import { recordUsage } from '@/lib/log';
import type { OnTrace } from '@/lib/agents/agent-trace';
import { loadAssembledMap, writePathReview } from '@/lib/agents/map/path-review';
import {
  detectHollowConcepts,
  detectDuplicationCandidates,
  normalizeLlmFindings,
  dedupeFindings,
  MAP_REVIEW_LLM_KINDS,
  type AssembledMap,
  type MapReviewFinding,
  type DuplicationCandidate,
} from '@/lib/agents/map/review-map';

const ReviewSchema = z.object({
  findings: z
    .array(
      z.object({
        kind: z.enum(MAP_REVIEW_LLM_KINDS),
        conceptSlugs: z.array(z.string()).default([]),
        message: z.string().min(1),
      }),
    )
    .default([]),
});

// Compose the whole freeze-boundary review: load the assembled map, review it, and
// persist the findings to the PathReview worklist. Shared by the remediation freeze
// hook (remediate-path.ts) and the manual driver (scripts/review-map.ts). The write
// is idempotent (replaces open rows, preserves resolved decisions). Returns the
// findings + how many were written so a caller/CLI can report them.
export async function reviewAndPersistMap(
  pathId: string,
  opts: { onTrace?: OnTrace; abortSignal?: AbortSignal } = {},
): Promise<{ findings: MapReviewFinding[]; written: number }> {
  const { onTrace = () => {}, abortSignal } = opts;
  // Audit 2.2: an aborted job skips the freeze review entirely — the caller's
  // best-effort wrapper treats the throw as a non-fatal skipped review.
  abortSignal?.throwIfAborted();
  const map = await loadAssembledMap(pathId);
  const findings = await reviewMap(map, onTrace, abortSignal);
  const { written } = await writePathReview(pathId, findings);
  return { findings, written };
}

// Review the final assembled map, returning findings to persist. Combines the LLM
// critic (duplication / granularity) with the deterministic hollow pass. Fail-open.
export async function reviewMap(
  map: AssembledMap,
  onTrace: OnTrace = () => {},
  abortSignal?: AbortSignal,
): Promise<MapReviewFinding[]> {
  const hollow = detectHollowConcepts(map.concepts);
  const candidates = detectDuplicationCandidates(map.concepts, map.topic);

  onTrace({
    kind: 'stage',
    label: 'map review started',
    detail: {
      topic: map.topic,
      concepts: map.concepts.length,
      edges: map.edges.length,
      dupCandidates: candidates.length,
      hollow: hollow.length,
    },
  });

  let llmFindings: MapReviewFinding[] = [];
  try {
    llmFindings = await callCritic(map, candidates, abortSignal);
  } catch (err) {
    // A job abort is NOT a critic fault — rethrow instead of degrading and
    // letting the zombie run continue into the PathReview write.
    if (abortSignal?.aborted) throw err;
    // A transient infra error (Vertex/network) must never fail the freeze — the
    // Path is already teachable. Degrade to the deterministic findings only.
    console.warn('[map-review] critic failed; using deterministic findings only', {
      topic: map.topic,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const findings = dedupeFindings([...llmFindings, ...hollow]);
  console.log('[map-review]', {
    topic: map.topic,
    findings: findings.map((f) => f.kind),
    dupCandidates: candidates.length,
  });
  onTrace({
    kind: 'stage',
    label: 'map review done',
    detail: { findingKinds: findings.map((f) => f.kind) },
  });
  return findings;
}

async function callCritic(
  map: AssembledMap,
  candidates: DuplicationCandidate[],
  abortSignal?: AbortSignal,
): Promise<MapReviewFinding[]> {
  const { model, temperature, maxOutputTokens, modelId } = getModel('mapReviewer');
  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    abortSignal,
    output: Output.object({ schema: ReviewSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(map, candidates),
  });
  const validSlugs = new Set(map.concepts.map((c) => c.slug));
  const findings = normalizeLlmFindings(result.experimental_output.findings, validSlugs);
  recordUsage('map.review-critic', result.usage);
  console.log('[map-review-critic]', {
    topic: map.topic,
    modelId,
    kinds: findings.map((f) => f.kind),
    usage: result.usage,
    finishReason: result.finishReason,
  });
  return findings;
}

const SYSTEM_PROMPT = `You are the pre-freeze reviewer of a curriculum concept map. You are given a topic and its FINAL assembled map — every concept (each tagged spine or frontier), the prerequisite edges, and each concept's chosen primary teaching resource — just before it is frozen and served to learners. An earlier reviewer already checked the spine skeleton; you review what it could NOT see: frontier concepts and remediation-split nodes added AFTER it ran, with resources attached.

Emit a short list of findings of exactly these kinds. Be precise and conservative — flag a real problem, not a preference. Most maps need zero or one finding.

- \`duplication\`: two concepts cover the SAME idea (redundant nodes). This happens when a frontier concept and a remediation-split node, or two split nodes, land on the same topic (e.g. "Database Views", "SQL Views", "SQL View Use Cases" are three nodes for one idea). You are given CANDIDATE PAIRS the heuristic flagged as similar — CONFIRM the genuine duplicates and REJECT the merely-related (e.g. "joins" and "subqueries" are related, not duplicates). You may also flag a duplicate pair not in the candidate list. Put BOTH concept slugs in \`conceptSlugs\`, and in \`message\` name which should be the merge WINNER (prefer the broader/spine concept) and why.
- \`granularity\`: a concept is too COARSE — it bundles several distinct teachable ideas into one node, so no single resource can teach all of it (e.g. a node titled "Joins, Subqueries, and CTEs"). Put the concept's slug in \`conceptSlugs\`; in \`message\` name the finer concepts to split it into and their prerequisite order. Only flag a genuine bundle of separate ideas, never a single idea taught broadly.

Do NOT flag coverage/resource-quality problems — those are handled separately. For every finding, write a \`message\` that states the problem AND the concrete fix.`;

function buildPrompt(map: AssembledMap, candidates: DuplicationCandidate[]): string {
  const conceptLine = (c: AssembledMap['concepts'][number]) => {
    const primary = c.primary
      ? `primary: "${c.primary.title}" (${c.primary.role} ${c.primary.coverageScore.toFixed(2)})`
      : 'primary: (none)';
    const relaxed = c.primaryRelaxed ? ', RELAXED' : '';
    return `- [${c.membership}] ${c.slug} — ${c.title} — ${primary}${relaxed}`;
  };
  return [
    `Topic: ${map.topic}`,
    '',
    'Concepts (membership, slug — title — chosen primary):',
    ...map.concepts.map(conceptLine),
    '',
    'Prerequisite edges (from → to, "learn from before to"):',
    ...(map.edges.length > 0 ? map.edges.map((e) => `- ${e.fromSlug} → ${e.toSlug}`) : ['(none)']),
    '',
    'Duplication CANDIDATE pairs the heuristic flagged as similar (confirm or reject each):',
    ...(candidates.length > 0
      ? candidates.map((c) => `- ${c.a} ~ ${c.b} (similarity ${c.similarity})`)
      : ['(none)']),
    '',
    'Review this map. Return no findings if it is sound; otherwise list the specific duplication / granularity problems to fix.',
  ].join('\n');
}
