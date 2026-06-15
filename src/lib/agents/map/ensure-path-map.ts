// Phase 2.5d-3: ensurePathMap — get-or-create a topic's spine concept map and
// persist it. Ties together the spine author (2.5d-1) and candidate attachment
// (2.5d-2), then writes Concepts + ConceptPrereq edges + ConceptResource links
// and sets the readiness gate (2.5d-3 policy, readiness.ts).
//
// Concurrency: a TWO-PHASE CLAIM, not a lock held across the build. The app
// connects through Supabase's transaction-mode pooler (src/lib/db.ts), where
// only transaction-scoped advisory locks are reliable — so we can't hold a lock
// across 30–60s of LLM calls without pinning a pooled backend behind an open
// transaction. Instead:
//   tx1 (claim, ms): advisory-lock the topic → if the Path exists, return it
//     (no rebuild); else INSERT a `building` Path. The lock serializes the claim;
//     @@unique([topic]) is the hard backstop.
//   (lock-free) author the spine + attach candidates — the slow part.
//   tx2 (populate, fast): write concepts/edges/links, compute readiness, set status.
// A crash between tx1 and tx2 leaves a `building` Path with no concepts; the
// stale-`building` reclaim is deferred to 2.5g (here, any existing Path is
// treated as "exists, skip"). The seed (2.5d-4) force-rebuilds by deleting first.

import { ConceptMembership, Difficulty, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildSpine } from '@/lib/agents/map/build-spine';
import { attachCandidates } from '@/lib/agents/map/attach-candidates';
import { computeReadiness } from '@/lib/agents/map/readiness';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type EnsurePathMapResult = {
  pathId: string;
  status: PathStatus;
  // True when this call built the map; false when an existing Path was returned.
  created: boolean;
  // Spine-hole concept slugs (concepts with no qualifying `teaches` primary).
  // Empty for an existing Path returned without a rebuild.
  holes: string[];
};

export class PathMapError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PathMapError';
  }
}

export async function ensurePathMap(args: {
  topic: string;
  subject?: string;
  onTrace?: OnTrace;
}): Promise<EnsurePathMapResult> {
  const { topic, subject, onTrace = () => {} } = args;

  // --- tx1: claim ---------------------------------------------------------
  const claim = await prisma.$transaction(async (tx) => {
    // Serialize concurrent first-requests for this topic. hashtext→bigint picks
    // the single-key advisory overload; an occasional cross-topic hash collision
    // only over-serializes, never corrupts.
    // $executeRaw (not $queryRaw): the lock returns void, which $queryRaw can't
    // deserialize. We only need the side effect, not a result set.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${topic})::bigint)`;
    const existing = await tx.path.findUnique({
      where: { topic },
      select: { id: true, status: true },
    });
    if (existing) return { path: existing, created: false as const };
    const path = await tx.path.create({
      // title/summary/difficulty are vestigial user-facing columns that retire
      // with PathItem at the 2.5g cutover; a concept map has no single difficulty.
      // Required (NOT NULL) until then, so set map-appropriate placeholders.
      data: {
        topic,
        title: topic,
        summary: `Concept map for ${topic}`,
        difficulty: Difficulty.beginner,
        status: PathStatus.building,
      },
      select: { id: true, status: true },
    });
    return { path, created: true as const };
  });

  if (!claim.created) {
    onTrace({ kind: 'info', label: 'path map exists', detail: { pathId: claim.path.id, status: claim.path.status } });
    return { pathId: claim.path.id, status: claim.path.status, created: false, holes: [] };
  }

  const pathId = claim.path.id;
  onTrace({ kind: 'stage', label: 'path map claimed', detail: { pathId, topic } });

  // --- lock-free: author + attach -----------------------------------------
  let holes: string[];
  let ready: boolean;
  try {
    const spine = await buildSpine({ topic, subject, onTrace });
    const attachments = await attachCandidates({ topic, concepts: spine.concepts, onTrace });
    const readiness = computeReadiness(attachments);
    holes = readiness.holes;
    ready = readiness.ready;

    // --- tx2: populate ----------------------------------------------------
    await prisma.$transaction(async (tx) => {
      await tx.concept.createMany({
        data: spine.concepts.map((c) => ({
          pathId,
          slug: c.slug,
          title: c.title,
          membership: ConceptMembership.spine,
        })),
      });
      const conceptRows = await tx.concept.findMany({
        where: { pathId },
        select: { id: true, slug: true },
      });
      const idBySlug = new Map(conceptRows.map((r) => [r.slug, r.id]));

      await tx.conceptPrereq.createMany({
        data: spine.edges.map((e) => ({
          pathId,
          fromConceptId: idBySlug.get(e.fromSlug)!,
          toConceptId: idBySlug.get(e.toSlug)!,
        })),
      });

      const links = attachments.flatMap((a) =>
        a.candidates.map((c) => ({
          conceptId: idBySlug.get(a.conceptSlug)!,
          resourceId: c.resourceId,
          role: c.role,
          coverageScore: c.coverageScore,
        })),
      );
      if (links.length > 0) await tx.conceptResource.createMany({ data: links });

      await tx.path.update({
        where: { id: pathId },
        data: { status: ready ? PathStatus.spine_ready : PathStatus.building },
      });
    });
  } catch (err) {
    // Best-effort: flip the claimed Path to `failed` so it's visibly broken
    // rather than a silent empty `building`. Swallow the flip's own error.
    await prisma.path
      .update({ where: { id: pathId }, data: { status: PathStatus.failed } })
      .catch(() => {});
    throw new PathMapError(`Failed to build spine map for topic '${topic}'.`, err);
  }

  const status = ready ? PathStatus.spine_ready : PathStatus.building;
  onTrace({ kind: 'stage', label: 'path map built', detail: { pathId, status, holes } });
  console.log('[map-ensure-path-map] built', { topic, pathId, status, holeCount: holes.length });
  return { pathId, status, created: true, holes };
}
