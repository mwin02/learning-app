// Phase 2.5d (spine hardening): the spine reviewer — a semantic critic over a
// STRUCTURALLY-VALID spine (validateSpine/cycle.ts already passed). The structural
// validator only proves the graph is a well-formed DAG; it cannot tell that the
// spine opens cold on a hard concept, assumes a foundation it never teaches, leaves
// a concept disconnected, or skips a backbone idea. Those are judgment calls, so a
// model makes them — and only here, after the cheap deterministic checks pass.
//
// This is ADVISORY, never a gate: it emits findings that build-spine.ts feeds back
// to the author for one bounded revision (SPINE_MAX_REVIEW_REPAIRS). It never edits
// the DAG itself (that would make it a second, unvalidated author) and it never
// blocks spine_ready — teachability (the resource gate, readiness.ts) remains the
// only hard readiness invariant. A thin topic the critic wishes were richer still
// ships; 2.5j thickens it later.
//
// Same call shape as spine-author.ts: a no-tools structured Output.object call, to
// sidestep the Gemini "tools + Output.object yields nothing" limitation.

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';
import type { OnTrace } from '@/lib/agents/agent-trace';
import type { AuthoredSpine } from '@/lib/agents/map/cycle';

// The kinds of gap the reviewer looks for. Kept as a closed set so build-spine.ts
// can branch/trace on them and the author repair prompt stays structured.
export const REVIEW_FINDING_KINDS = [
  // The spine dives into a hard concept with no orientation/on-ramp — an absolute
  // beginner has nowhere to start. The fix is a foundational root concept.
  'onboarding',
  // A concept is taught that assumes knowledge the spine never establishes (an
  // implicit prerequisite that should be its own concept).
  'missing-foundation',
  // A concept is orphaned (no edges) or the graph is fragmented when it shouldn't
  // be — a prerequisite link is missing.
  'connectivity',
  // A backbone idea the topic genuinely needs is absent (a true gap, not enrichment).
  'completeness',
] as const;

export type ReviewFindingKind = (typeof REVIEW_FINDING_KINDS)[number];

export type ReviewFinding = {
  kind: ReviewFindingKind;
  // Human/model-readable detail: what's missing/wrong and how to fix it. For an
  // onboarding/missing-foundation/completeness finding, name the concept to ADD;
  // for connectivity, name the edge(s) to add. The author acts on this text.
  message: string;
};

export type SpineReview = {
  // True when the spine has no material gap — the author need not revise.
  ok: boolean;
  findings: ReviewFinding[];
};

const ReviewSchema = z.object({
  ok: z.boolean(),
  findings: z
    .array(
      z.object({
        kind: z.enum(REVIEW_FINDING_KINDS),
        message: z.string().min(1),
      }),
    )
    .default([]),
});

export type ReviewSpineArgs = {
  topic: string;
  // The subject domain ({math, science, cs}), when known — a math spine's
  // onboarding (notation, the big picture) differs from a cs spine's (setup, how
  // to run code), so this grounds what "a good on-ramp" means.
  subject?: string;
  spine: AuthoredSpine;
  onTrace?: OnTrace;
};

// Review a structurally-valid spine for semantic completeness. Returns findings;
// an empty/ok review means no revision is warranted. Defensive: the caller treats
// a thrown review (transient infra error) as "no findings" so a flaky critic call
// never fails an otherwise-valid build — the spine is already structurally sound.
export async function reviewSpine(args: ReviewSpineArgs): Promise<SpineReview> {
  const { topic, subject, spine, onTrace = () => {} } = args;
  const { model, temperature, maxOutputTokens, modelId } = getModel('mapSpineReviewer');

  onTrace({
    kind: 'stage',
    label: 'spine review started',
    detail: { topic, subject, concepts: spine.concepts.length, edges: spine.edges.length },
  });

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: ReviewSchema }),
    system: SYSTEM_PROMPT,
    prompt: buildPrompt({ topic, subject, spine }),
  });

  const review = result.experimental_output;
  // The model can set ok:true while still listing findings, or vice-versa;
  // reconcile so the caller has one source of truth (findings drive the decision).
  const normalized: SpineReview = {
    ok: review.findings.length === 0,
    findings: review.findings,
  };

  // TODO(observability): fold into the structured logger (see curriculum-agent.ts).
  console.log('[map-spine-review]', {
    topic,
    modelId,
    ok: normalized.ok,
    findings: normalized.findings.map((f) => f.kind),
    usage: result.usage,
    finishReason: result.finishReason,
  });

  onTrace({
    kind: 'stage',
    label: 'spine review done',
    detail: { ok: normalized.ok, findingKinds: normalized.findings.map((f) => f.kind) },
  });
  return normalized;
}

const SYSTEM_PROMPT = `You are the spine reviewer of a curriculum map-builder. You are given a topic and its SPINE — the required backbone of its concept map: a list of concepts plus directed prerequisite edges ("learn \`from\` before \`to\`"), which already form a valid acyclic graph. Your job is to judge whether this backbone is COMPLETE and well-sequenced enough to teach an absolute beginner, and to flag specific gaps for the author to fix.

You are a critic, not the author: you do NOT rewrite the spine. You emit a short list of findings; another pass regenerates the spine from your feedback. Be precise and conservative — flag a real gap, not a preference. A spine that is already sound should return \`ok: true\` with NO findings. Most well-authored spines need zero or one finding; never invent gaps to look thorough.

Look for exactly these kinds of gap:

- \`onboarding\`: the spine dives straight into a hard concept with no orientation, so an absolute beginner has nowhere to start. A good spine OPENS with a foundational on-ramp concept — what the subject is, the mental model, and (as the subject warrants) how to set up / run / read it — that everything else builds on. If the first concept(s) already assume the learner is oriented, flag this and name the onboarding concept to ADD at the root (e.g. "Getting Started with X: what it is, environment setup, your first program"). For a math subject the on-ramp is conceptual (the big picture, notation, prerequisite review), not tooling setup. Flag at most ONE onboarding gap.
- \`missing-foundation\`: a concept is taught that clearly assumes knowledge the spine never establishes as its own concept (an implicit prerequisite). Name the foundational concept to ADD and which concept depends on it.
- \`connectivity\`: a concept is orphaned (no prerequisite edges in or out when it plainly should have them), or the graph splits into disconnected pieces that should link. Name the missing edge(s).
- \`completeness\`: a backbone concept the topic genuinely requires is absent. This is for a TRUE gap in the required core only — NOT optional enrichment, niche subtopics, or tooling (those are the opt-in "frontier", added later). Name the concept to ADD.

For every finding, write a \`message\` that states the gap AND the concrete fix (the concept to add with a short description, or the edge to add), so the author can act on it directly.`;

function buildPrompt(args: { topic: string; subject?: string; spine: AuthoredSpine }): string {
  const { topic, subject, spine } = args;
  return [
    `Topic: ${topic}`,
    `Subject domain: ${subject?.trim() ? subject : '(unspecified)'}`,
    '',
    'Spine concepts (slug — title):',
    ...spine.concepts.map((c) => `- ${c.slug} — ${c.title}`),
    '',
    'Prerequisite edges (from → to, "learn from before to"):',
    ...(spine.edges.length > 0
      ? spine.edges.map((e) => `- ${e.fromSlug} → ${e.toSlug}`)
      : ['(none)']),
    '',
    'Review this spine. Return `ok: true` with no findings if it is sound; otherwise list the specific gaps to fix.',
  ].join('\n');
}
