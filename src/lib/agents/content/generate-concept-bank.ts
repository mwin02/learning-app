// Phase 2.5h-3: the orchestrator around the bank author (author-concept-bank.ts) —
// loads a concept's context, persists its authored questions as ConceptQuestion
// rows, and fans that out across a Path's whole concept map with bounded
// concurrency.
//
// Wired best-effort into the worker pipeline right after a Path reaches
// `spine_ready` (course-worker.ts): every spine concept then has its resources
// attached, so banks are grounded in real material. Non-fatal — a Path with no
// banks (generation failed, or frontier concepts added later by thickening) still
// builds Tracks; those Tracks just skip exercises for the bankless concepts, and
// the discovery API (2.5h-5) surfaces them for operator authoring.
//
// Idempotent + backfillable: only concepts with ZERO questions are (re)generated,
// so re-running is safe and picks up concepts added since the last pass. The
// per-concept entry point doubles as the "regenerate this concept" hook.

import { prisma } from '@/lib/db';
import { authorConceptBank } from '@/lib/agents/content/author-concept-bank';
import { CONCEPT_BANK_GEN_CONCURRENCY } from '@/lib/config';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type GenerateConceptBankResult = {
  conceptId: string;
  // 'skipped' when the concept already had questions (idempotent no-op); 'generated'
  // when we authored + persisted; 'empty' when the author returned nothing usable;
  // 'onramp' when we deliberately skip the broad orientation concept (2.5h).
  outcome: 'generated' | 'skipped' | 'empty' | 'onramp';
  generated: number;
};

// Generate + persist one concept's bank. Skips (no LLM call) if the concept already
// has questions, so it's safe to call repeatedly. Throws only on a DB/load error;
// an author failure propagates to the caller (the fan-out isolates it per concept).
export async function generateConceptBank(args: {
  conceptId: string;
  onTrace?: OnTrace;
  abortSignal?: AbortSignal; // H4: worker job-deadline signal
}): Promise<GenerateConceptBankResult> {
  const { conceptId, onTrace = () => {}, abortSignal } = args;

  const concept = await prisma.concept.findUnique({
    where: { id: conceptId },
    select: {
      id: true,
      slug: true,
      title: true,
      isOnRamp: true,
      path: { select: { topic: true } },
      _count: { select: { questions: true } },
      resources: {
        orderBy: { coverageScore: 'desc' },
        select: { resource: { select: { title: true, type: true } } },
      },
    },
  });
  if (!concept) throw new Error(`generateConceptBank: no Concept '${conceptId}'.`);

  // Skip the on-ramp: it's the deliberately BROAD orientation concept (what the
  // subject is + getting started), so auto-authored questions over-reach into deep
  // specifics that don't belong on an intro. No bank here by design (2.5h).
  if (concept.isOnRamp) {
    return { conceptId, outcome: 'onramp', generated: 0 };
  }

  // Idempotent: a concept that already has a bank is left untouched.
  if (concept._count.questions > 0) {
    return { conceptId, outcome: 'skipped', generated: 0 };
  }

  const questions = await authorConceptBank({
    topic: concept.path.topic,
    conceptTitle: concept.title,
    conceptSlug: concept.slug,
    isOnRamp: concept.isOnRamp,
    resources: concept.resources.map((r) => ({ title: r.resource.title, type: r.resource.type })),
    onTrace,
    abortSignal,
  });

  if (questions.length === 0) {
    return { conceptId, outcome: 'empty', generated: 0 };
  }

  // Single-flight the persist. The `_count.questions` check above is a cheap fast
  // path, but it's a read-then-write: two concurrent generates for the SAME concept
  // (a future multi-worker pool; the worker is concurrency-1 today) could both see 0
  // and both insert, doubling the bank — the one pipeline step lacking the
  // single-flight backstop the others have (RemediationJob's partial-unique index,
  // ensurePathMap's advisory lock). Lock the concept row, then RE-CHECK the count
  // inside the lock before writing. The slow LLM call stays OUTSIDE the lock; the
  // loser of a race just discards its freshly-authored set and reports `skipped`.
  const added = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Concept" WHERE "id" = ${conceptId} FOR UPDATE`;
    if ((await tx.conceptQuestion.count({ where: { conceptId } })) > 0) return 0;
    const res = await tx.conceptQuestion.createMany({
      data: questions.map((q) => ({
        conceptId,
        prompt: q.prompt,
        answer: q.answer,
        rubric: q.rubric,
        kind: q.kind,
        // origin defaults to `agent` — this is the generated baseline set.
      })),
    });
    return res.count;
  });

  // Lost the race (a concurrent writer persisted first) — idempotent no-op.
  if (added === 0) return { conceptId, outcome: 'skipped', generated: 0 };

  return { conceptId, outcome: 'generated', generated: added };
}

export type BackfillConceptBanksResult = {
  candidates: number; // concepts that lacked a bank (eligible for generation)
  generated: number; // concepts we authored + persisted a bank for
  empty: number; // concepts the author returned nothing usable for
  failed: number; // concepts whose generation threw
  questions: number; // total questions persisted across the Path
};

// Generate banks for every concept in a Path that doesn't yet have one, fanned out
// with bounded concurrency (CONCEPT_BANK_GEN_CONCURRENCY) — one independent Pro
// call per concept, like the candidate judge. Best-effort: a single concept's
// failure is logged and skipped, never failing the batch. Returns a summary.
export async function backfillConceptBanks(args: {
  pathId: string;
  onTrace?: OnTrace;
  abortSignal?: AbortSignal; // H4: worker job-deadline signal
}): Promise<BackfillConceptBanksResult> {
  const { pathId, onTrace = () => {}, abortSignal } = args;

  // Only concepts with no questions — the idempotent + backfill filter. On-ramp
  // concepts are excluded by design (no bank for the broad orientation concept;
  // generateConceptBank guards this too, so a direct call is also safe).
  const concepts = await prisma.concept.findMany({
    where: { pathId, isOnRamp: false, questions: { none: {} } },
    select: { id: true, slug: true },
  });

  onTrace({
    kind: 'stage',
    label: 'concept bank backfill started',
    detail: { pathId, candidates: concepts.length, concurrency: CONCEPT_BANK_GEN_CONCURRENCY },
  });

  const result: BackfillConceptBanksResult = {
    candidates: concepts.length,
    generated: 0,
    empty: 0,
    failed: 0,
    questions: 0,
  };

  for (let i = 0; i < concepts.length; i += CONCEPT_BANK_GEN_CONCURRENCY) {
    abortSignal?.throwIfAborted();
    const chunk = concepts.slice(i, i + CONCEPT_BANK_GEN_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((c) => generateConceptBank({ conceptId: c.id, onTrace, abortSignal })),
    );
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') {
        if (s.value.outcome === 'generated') {
          result.generated++;
          result.questions += s.value.generated;
        } else if (s.value.outcome === 'empty') {
          result.empty++;
        }
        return;
      }
      result.failed++;
      console.error('[content-backfill-banks] concept generation rejected', {
        concept: chunk[j].slug,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
    });
  }

  onTrace({
    kind: 'stage',
    label: 'concept bank backfill done',
    detail: { pathId, ...result },
  });
  console.log('[content-backfill-banks] done', { pathId, ...result });

  return result;
}
