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
  // when we authored + persisted; 'empty' when the author returned nothing usable.
  outcome: 'generated' | 'skipped' | 'empty';
  generated: number;
};

// Generate + persist one concept's bank. Skips (no LLM call) if the concept already
// has questions, so it's safe to call repeatedly. Throws only on a DB/load error;
// an author failure propagates to the caller (the fan-out isolates it per concept).
export async function generateConceptBank(args: {
  conceptId: string;
  onTrace?: OnTrace;
}): Promise<GenerateConceptBankResult> {
  const { conceptId, onTrace = () => {} } = args;

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
  });

  if (questions.length === 0) {
    return { conceptId, outcome: 'empty', generated: 0 };
  }

  await prisma.conceptQuestion.createMany({
    data: questions.map((q) => ({
      conceptId,
      prompt: q.prompt,
      answer: q.answer,
      rubric: q.rubric,
      kind: q.kind,
      // origin defaults to `agent` — this is the generated baseline set.
    })),
  });

  return { conceptId, outcome: 'generated', generated: questions.length };
}

export type BackfillConceptBanksResult = {
  candidates: number; // concepts that lacked a bank (eligible for generation)
  generated: number; // concepts we authored + persisted a bank for
  empty: number; // concepts the author returned nothing usable for
  failed: number; // concepts whose generation threw
  questions: number; // total questions persisted across the Path
};

// Generate banks for every concept in a Path that doesn't yet have one, fanned out
// with bounded concurrency (CONCEPT_BANK_GEN_CONCURRENCY) — one independent Flash
// call per concept, like the candidate judge. Best-effort: a single concept's
// failure is logged and skipped, never failing the batch. Returns a summary.
export async function backfillConceptBanks(args: {
  pathId: string;
  onTrace?: OnTrace;
}): Promise<BackfillConceptBanksResult> {
  const { pathId, onTrace = () => {} } = args;

  // Only concepts with no questions — the idempotent + backfill filter.
  const concepts = await prisma.concept.findMany({
    where: { pathId, questions: { none: {} } },
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
    const chunk = concepts.slice(i, i + CONCEPT_BANK_GEN_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((c) => generateConceptBank({ conceptId: c.id, onTrace })),
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
