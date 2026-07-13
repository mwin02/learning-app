// Phase 2.5d-1: spine-build orchestrator — author → validate → bounded repair.
//
// Composes the two pure-ish halves of this block: the generative author
// (spine-author.ts) and the deterministic DAG validator (cycle.ts). The model
// occasionally emits a cyclic, dangling, or out-of-range spine; rather than fail
// the build or silently auto-break an edge (which would drop a pedagogically
// meaningful prerequisite without anyone noticing), we feed the specific defects
// back and let the author repair its own structure, bounded by SPINE_MAX_REPAIRS
// — the same bounded-revise shape as the AR-6 curriculum critic.
//
// Persistence (get-or-create Path under a lock, write Concepts/edges) and
// candidate attachment are later blocks (2.5d-2/3); this module stops at a
// validated in-memory DAG.

import { authorSpine } from '@/lib/agents/map/spine-author';
import { validateSpine, type AuthoredSpine, type SpineDefect } from '@/lib/agents/map/cycle';
import { reviewSpine, type ReviewFinding } from '@/lib/agents/map/review-spine';
import { SPINE_MAX_REPAIRS, SPINE_MAX_REVIEW_REPAIRS } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type BuildSpineArgs = {
  topic: string;
  subject?: string;
  onTrace?: OnTrace;
  // Workers-A2 (D7): the worker's per-job abort (deadline or shutdown). Forwarded
  // into the author/review AI calls and checked between attempts, so a released
  // job stops within one network round-trip instead of finishing a minutes-long
  // authoring loop it no longer owns.
  abortSignal?: AbortSignal;
};

export class SpineBuildError extends Error {
  // The defects from the final failed attempt, so the caller (and a future
  // human/agent review surface) can see why the repair budget was exhausted.
  readonly defects: SpineDefect[];
  constructor(message: string, defects: SpineDefect[]) {
    super(message);
    this.name = 'SpineBuildError';
    this.defects = defects;
  }
}

// Returns a spine whose edges are a validated DAG over its concept slugs. Throws
// SpineBuildError if the author can't produce a valid one within the repair
// budget — the spine is the gating backbone, so a still-invalid structure must
// not be persisted as if it were sound (a partial/cyclic map silently corrupts
// every Track built over it).
export async function buildSpine(args: BuildSpineArgs): Promise<AuthoredSpine> {
  const { topic, subject, onTrace = () => {}, abortSignal } = args;
  let repairFeedback: string | undefined;
  let lastDefects: SpineDefect[] = [];
  // Two independent budgets so a string of structural failures can't starve the
  // semantic-review revision (and vice-versa): structural repairs gate persisting
  // a broken DAG (hard); a review repair is one advisory hardening pass.
  let structuralRepairs = 0;
  let reviewRepairs = 0;
  // The most recent structurally-valid spine. A review-driven re-author can come
  // back broken; if that exhausts the structural budget we fall back to this last
  // sound spine (the hardening was best-effort) rather than failing a build that
  // already had a valid DAG in hand.
  let lastValidSpine: AuthoredSpine | undefined;

  // Bounded by the sum of both budgets plus the initial attempt; the explicit
  // counters below decide when to stop, this only guards against a logic slip.
  const maxIterations = SPINE_MAX_REPAIRS + SPINE_MAX_REVIEW_REPAIRS + 1;
  for (let attempt = 0; attempt < maxIterations; attempt++) {
    abortSignal?.throwIfAborted();
    let spine: AuthoredSpine;
    try {
      spine = await authorSpine({ topic, subject, repairFeedback, onTrace, abortSignal });
    } catch (err) {
      // An abort (deadline/shutdown) is NOT a transient author failure — rethrow
      // instead of burning a repair attempt retrying a job we no longer own.
      if (abortSignal?.aborted) throw err;
      // The author call threw (transient Vertex/network error, or output the
      // permissive schema still couldn't parse). Consume a structural attempt and
      // retry rather than aborting the whole build. We deliberately do NOT set
      // repairFeedback: there's no model output to repair, and feeding an infra
      // error string back as instructions would only confuse the next call.
      const message = err instanceof Error ? err.message : String(err);
      lastDefects = [{ kind: 'author_error', message }];
      onTrace({ kind: 'stage', label: 'spine author error', detail: { attempt, error: message } });
      console.log('[map-build-spine] author error', { topic, attempt, error: message });
      if (structuralRepairs >= SPINE_MAX_REPAIRS) break;
      structuralRepairs++;
      continue;
    }

    // --- structural gate (cycle.ts): hard — never persist a broken DAG ---------
    const result = validateSpine(spine);
    if (!result.ok) {
      lastDefects = result.defects;
      onTrace({
        kind: 'stage',
        label: 'spine validation failed',
        detail: { attempt, defectCount: result.defects.length, kinds: result.defects.map((d) => d.kind) },
      });
      console.log('[map-build-spine] validation failed', {
        topic,
        attempt,
        defects: result.defects.map((d) => d.kind),
      });
      if (structuralRepairs >= SPINE_MAX_REPAIRS) break;
      structuralRepairs++;
      repairFeedback = formatDefects(result.defects);
      continue;
    }

    lastValidSpine = spine;
    onTrace({
      kind: 'stage',
      label: 'spine validated',
      detail: { attempt, concepts: spine.concepts.length, edges: spine.edges.length },
    });

    // --- semantic review (advisory): one bounded hardening revision -----------
    // Only worth a review call while a revision is still affordable; once the
    // review budget is spent we ship the structurally-valid spine as-is. A thrown
    // review never fails the build — the spine is already sound, so degrade to "no
    // findings" and return it.
    if (reviewRepairs >= SPINE_MAX_REVIEW_REPAIRS) return spine;
    let review;
    try {
      review = await reviewSpine({ topic, subject, spine, onTrace, abortSignal });
    } catch (err) {
      // An aborted review still ships the (already valid) spine — the pipeline's
      // own next checkpoint decides the job's fate; no work is lost either way.
      console.warn('[map-build-spine] spine review failed; shipping validated spine', {
        topic,
        error: err instanceof Error ? err.message : String(err),
      });
      return spine;
    }
    if (review.ok) return spine;

    reviewRepairs++;
    repairFeedback = formatReview(review.findings);
    console.log('[map-build-spine] review findings; revising', {
      topic,
      findings: review.findings.map((f) => f.kind),
    });
  }

  // Budgets exhausted. If a structurally-valid spine was produced at any point
  // (e.g. a hardening revision regressed the DAG), ship it — best-effort hardening
  // must never lose a sound spine. Only fail if we never got a valid DAG at all.
  if (lastValidSpine) {
    onTrace({
      kind: 'stage',
      label: 'spine hardening exhausted; using last valid spine',
      detail: { concepts: lastValidSpine.concepts.length, edges: lastValidSpine.edges.length },
    });
    return lastValidSpine;
  }
  throw new SpineBuildError(
    `Spine author could not produce a valid DAG for topic '${topic}' within ${SPINE_MAX_REPAIRS} repair(s).`,
    lastDefects,
  );
}

// Render review findings as a numbered list for the author repair prompt — same
// shape as formatDefects so the author sees a consistent "fix these" instruction.
// Unlike structural defects, these are semantic asks (add a concept, add an edge).
function formatReview(findings: ReviewFinding[]): string {
  return findings.map((f, i) => `${i + 1}. [${f.kind}] ${f.message}`).join('\n');
}

// Render defects as a numbered list for the repair prompt. One line per defect;
// the author is told to return the full corrected spine, not a patch.
function formatDefects(defects: SpineDefect[]): string {
  return defects.map((d, i) => `${i + 1}. [${d.kind}] ${d.message}`).join('\n');
}
