// POST /api/playground/map-edit — internal map-curation API that applies a
// structural edit to a topic's concept map (Phase 2.5d-6), so humans and agents
// can review & edit a map at any point instead of hand-editing the DB. Sibling to
// decomposition-review: same error envelope, same withAdminAuth gate (NEVER the
// user-auth withAuth — a signed-in customer must never reach it; today both are
// the DEV_AUTH placeholder, they diverge in Phase 3).
//
// Body: a discriminated union on `action` (see map-edit-schema.ts). Structural ops
// only here — Concept add/edit/remove, membership flips, prereq edges (add is
// cycle-validated via cycle.ts). ConceptResource attach/detach/rescore land in
// 2.5d-6b. Every mutating action recomputes + persists Path readiness and the
// response echoes { pathId, pathStatus, holes, reason? }.

import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { mapEditSchema, type MapEditInput } from '@/lib/api/map-edit-schema';
import { wouldCreateCycle } from '@/lib/agents/map/cycle';
import { recomputeReadiness, type RecomputeResult } from '@/lib/agents/map/recompute-readiness';

// Prisma + the recompute query need Node, not Edge. No long LLM work here, so the
// default route timeout is plenty.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'CONFLICT' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// Unique-constraint violation (e.g. duplicate concept slug, duplicate edge).
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input: MapEditInput;
  try {
    input = mapEditSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  try {
    // Each branch resolves the affected pathId and performs its guarded mutation
    // together with the readiness recompute in ONE transaction, returning the
    // resulting Path status + holes (so mutation and status commit atomically).
    const result = await applyEdit(input);
    if ('error' in result) return result.error;

    const { pathId, conceptId, status, holes } = result;
    console.log('[map-edit]', {
      action: input.action,
      pathId,
      status,
      holeCount: holes.length,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return Response.json({
      pathId,
      pathStatus: status,
      holes,
      // add_concept returns the new id so an agent can chain edges/links onto it.
      ...(conceptId ? { conceptId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return errorResponse(409, 'CONFLICT', 'Edit conflicts with an existing row (duplicate slug or edge).');
    }
    console.error('[map-edit] failure', { action: input.action, err });
    return errorResponse(500, 'INTERNAL', 'Internal error applying map edit.');
  }
});

type EditSuccess = { pathId: string; conceptId?: string } & RecomputeResult;

// Performs the mutation + readiness recompute (atomically, in one transaction)
// and returns the affected pathId plus the resulting status/holes, or an early
// error Response. Throws on unexpected DB errors (caught + mapped above).
async function applyEdit(input: MapEditInput): Promise<EditSuccess | { error: Response }> {
  switch (input.action) {
    case 'add_concept': {
      const path = await prisma.path.findUnique({ where: { id: input.pathId }, select: { id: true } });
      if (!path) return { error: errorResponse(404, 'NOT_FOUND', `Path ${input.pathId} not found.`) };
      const { mutation, status, holes } = await mutateAndRecompute(input.pathId, (tx) =>
        tx.concept.create({
          data: { pathId: input.pathId, slug: input.slug, title: input.title, membership: input.membership },
          select: { id: true },
        }),
      );
      return { pathId: input.pathId, conceptId: mutation.id, status, holes };
    }

    case 'edit_concept': {
      const concept = await loadConcept(input.conceptId);
      if (!concept) return { error: notFoundConcept(input.conceptId) };
      const { status, holes } = await mutateAndRecompute(concept.pathId, (tx) =>
        tx.concept.update({ where: { id: input.conceptId }, data: { title: input.title } }),
      );
      return { pathId: concept.pathId, status, holes };
    }

    case 'set_membership': {
      const concept = await loadConcept(input.conceptId);
      if (!concept) return { error: notFoundConcept(input.conceptId) };
      const { status, holes } = await mutateAndRecompute(concept.pathId, (tx) =>
        tx.concept.update({ where: { id: input.conceptId }, data: { membership: input.membership } }),
      );
      return { pathId: concept.pathId, status, holes };
    }

    case 'remove_concept': {
      const concept = await loadConcept(input.conceptId);
      if (!concept) return { error: notFoundConcept(input.conceptId) };
      const { status, holes } = await mutateAndRecompute(concept.pathId, (tx) =>
        // Edges (both directions) + ConceptResource links cascade via onDelete.
        tx.concept.delete({ where: { id: input.conceptId } }),
      );
      return { pathId: concept.pathId, status, holes };
    }

    case 'add_prereq': {
      const guard = await resolveEdgeConcepts(input.fromConceptId, input.toConceptId);
      if ('error' in guard) return guard;
      const { pathId } = guard;
      // Self-loop is also blocked by a DB CHECK, but reject early with a clearer 400.
      if (input.fromConceptId === input.toConceptId) {
        return { error: errorResponse(400, 'INVALID_INPUT', 'A concept cannot be its own prerequisite.') };
      }
      // Serialize edge inserts on this Path so the cycle check can't race. An
      // advisory xact lock makes a concurrent add_prereq wait, then re-read the
      // edge set INCLUDING our edge. Without it, two concurrent inserts (e.g.
      // A→B and B→A) could each pass wouldCreateCycle and together persist a
      // cycle the DB has no constraint to reject — corrupting every Track built
      // over the map. The cycle check + create + recompute all run in this tx.
      const outcome = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pathId})::bigint)`;
        const existing = await tx.conceptPrereq.findMany({
          where: { pathId },
          select: { fromConceptId: true, toConceptId: true },
        });
        const cyclic = wouldCreateCycle(
          existing.map((e) => ({ fromId: e.fromConceptId, toId: e.toConceptId })),
          { fromId: input.fromConceptId, toId: input.toConceptId },
        );
        if (cyclic) return { cyclic: true as const };
        // Duplicate edge → P2002 → 409 (mapped in the outer catch).
        await tx.conceptPrereq.create({
          data: { pathId, fromConceptId: input.fromConceptId, toConceptId: input.toConceptId },
        });
        const readiness = await recomputeReadiness(pathId, tx);
        return { cyclic: false as const, ...readiness };
      });
      if (outcome.cyclic) {
        return { error: errorResponse(409, 'CONFLICT', 'Edge would create a prerequisite cycle.') };
      }
      return { pathId, status: outcome.status, holes: outcome.holes };
    }

    case 'remove_prereq': {
      const guard = await resolveEdgeConcepts(input.fromConceptId, input.toConceptId);
      if ('error' in guard) return guard;
      const { status, holes } = await mutateAndRecompute(guard.pathId, (tx) =>
        // Idempotent delete: a missing edge is a no-op (count 0), not an error —
        // the map ends in the requested state either way.
        tx.conceptPrereq.deleteMany({
          where: { fromConceptId: input.fromConceptId, toConceptId: input.toConceptId },
        }),
      );
      return { pathId: guard.pathId, status, holes };
    }
  }
}

// Run a mutation and the readiness recompute in one transaction, so the Path's
// stored status can never disagree with the rows the edit just changed. Returns
// the mutation's own result alongside the recomputed status/holes.
async function mutateAndRecompute<T>(
  pathId: string,
  mutate: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ mutation: T } & RecomputeResult> {
  return prisma.$transaction(async (tx) => {
    const mutation = await mutate(tx);
    const readiness = await recomputeReadiness(pathId, tx);
    return { mutation, ...readiness };
  });
}

async function loadConcept(conceptId: string) {
  return prisma.concept.findUnique({ where: { id: conceptId }, select: { pathId: true } });
}

function notFoundConcept(conceptId: string): Response {
  return errorResponse(404, 'NOT_FOUND', `Concept ${conceptId} not found.`);
}

// Both endpoints of a prereq edge must exist and live in the SAME Path (an edge is
// strictly intra-Path — ConceptPrereq.pathId is the integrity anchor). Returns the
// shared pathId or an early error Response.
async function resolveEdgeConcepts(
  fromConceptId: string,
  toConceptId: string,
): Promise<{ pathId: string } | { error: Response }> {
  const ids = [...new Set([fromConceptId, toConceptId])];
  const concepts = await prisma.concept.findMany({
    where: { id: { in: ids } },
    select: { id: true, pathId: true },
  });
  const byId = new Map(concepts.map((c) => [c.id, c.pathId]));
  const fromPath = byId.get(fromConceptId);
  const toPath = byId.get(toConceptId);
  if (!fromPath || !toPath) {
    const missing = !fromPath ? fromConceptId : toConceptId;
    return { error: errorResponse(404, 'NOT_FOUND', `Concept ${missing} not found.`) };
  }
  if (fromPath !== toPath) {
    return { error: errorResponse(400, 'INVALID_INPUT', 'Both concepts must belong to the same Path.') };
  }
  return { pathId: fromPath };
}
