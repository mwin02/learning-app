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
import { SPINE_MAX_REPAIRS } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type BuildSpineArgs = {
  topic: string;
  subject?: string;
  onTrace?: OnTrace;
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
  const { topic, subject, onTrace = () => {} } = args;
  let repairFeedback: string | undefined;
  let lastDefects: SpineDefect[] = [];

  for (let attempt = 0; attempt <= SPINE_MAX_REPAIRS; attempt++) {
    let spine: AuthoredSpine;
    try {
      spine = await authorSpine({ topic, subject, repairFeedback, onTrace });
    } catch (err) {
      // The author call threw (transient Vertex/network error, or output the
      // permissive schema still couldn't parse). Consume the attempt and retry
      // rather than aborting the whole build. We deliberately do NOT set
      // repairFeedback: there's no model output to repair, and feeding an infra
      // error string back as instructions would only confuse the next call.
      const message = err instanceof Error ? err.message : String(err);
      lastDefects = [{ kind: 'author_error', message }];
      onTrace({
        kind: 'stage',
        label: 'spine author error',
        detail: { attempt, error: message },
      });
      console.log('[map-build-spine] author error', { topic, attempt, error: message });
      continue;
    }
    const result = validateSpine(spine);

    if (result.ok) {
      onTrace({
        kind: 'stage',
        label: 'spine validated',
        detail: { attempt, concepts: spine.concepts.length, edges: spine.edges.length },
      });
      return spine;
    }

    lastDefects = result.defects;
    repairFeedback = formatDefects(result.defects);
    onTrace({
      kind: 'stage',
      label: 'spine validation failed',
      detail: {
        attempt,
        defectCount: result.defects.length,
        kinds: result.defects.map((d) => d.kind),
      },
    });
    console.log('[map-build-spine] validation failed', {
      topic,
      attempt,
      defects: result.defects.map((d) => d.kind),
    });
  }

  throw new SpineBuildError(
    `Spine author could not produce a valid DAG for topic '${topic}' within ${SPINE_MAX_REPAIRS} repair(s).`,
    lastDefects,
  );
}

// Render defects as a numbered list for the repair prompt. One line per defect;
// the author is told to return the full corrected spine, not a patch.
function formatDefects(defects: SpineDefect[]): string {
  return defects.map((d, i) => `${i + 1}. [${d.kind}] ${d.message}`).join('\n');
}
