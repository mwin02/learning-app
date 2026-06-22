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
// A crash between tx1 and tx2 leaves a `building` Path with no concepts. Phase
// 2.5g-2 reclaims it: tx1 treats a `failed` Path, and a stale empty `building` one,
// as rebuildable (reset the SAME row to `building`, fall through to populate); a
// healthy `spine_ready` / holey-`building` / fresh-`building` Path is still
// "exists, skip". See isReclaimable. The seed (2.5d-4) force-rebuilds by deleting first.

import { ConceptMembership, Difficulty, PathStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { PATH_BUILD_STALE_MS } from '@/lib/config';
import { buildSpine } from '@/lib/agents/map/build-spine';
import { attachCandidates } from '@/lib/agents/map/attach-candidates';
import { computeReadiness } from '@/lib/agents/map/readiness';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type EnsurePathMapResult = {
  pathId: string;
  status: PathStatus;
  // True when this call built the map; false when an existing Path was returned.
  // A reclaim (rebuild over a failed/stale Path) counts as built → created: true.
  created: boolean;
  // True when this call rebuilt over an existing non-self-healing Path (a `failed`
  // build, or a stale empty `building` claim that crashed before populate).
  reclaimed: boolean;
  // Spine-hole concept slugs (concepts with no qualifying `teaches` primary).
  // Empty for an existing Path returned without a rebuild.
  holes: string[];
};

// Phase 2.5g-2: should an EXISTING Path be rebuilt rather than returned as-is?
// Pure so the decision unit-tests without a DB.
//   - `failed`: the build threw and the catch flipped it; its builder is terminal,
//     so rebuild immediately (no age gate).
//   - `building` WITH concepts: a real spine that merely has holes → remediation's
//     job, not a rebuild. Left alone.
//   - `building` with ZERO concepts: a claim that crashed (process killed) between
//     tx1 and the lock-free populate. Age-gate it (PATH_BUILD_STALE_MS): the
//     populate phase runs ~30–60s after the claim commits with no Path write, so a
//     fresh empty `building` Path may be a build still legitimately in flight — only
//     reclaim once it's older than a build could plausibly take.
//   - `spine_ready` / `draft`: never reclaimed here.
export function isReclaimable(status: PathStatus, conceptCount: number, updatedAt: Date): boolean {
  if (status === PathStatus.failed) return true;
  return (
    status === PathStatus.building &&
    conceptCount === 0 &&
    Date.now() - updatedAt.getTime() > PATH_BUILD_STALE_MS
  );
}

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
      select: { id: true, status: true, updatedAt: true, _count: { select: { concepts: true } } },
    });
    if (existing) {
      if (!isReclaimable(existing.status, existing._count.concepts, existing.updatedAt)) {
        return { path: { id: existing.id, status: existing.status }, created: false as const, reclaimed: false as const };
      }
      // Rebuildable: reset the SAME row to `building` and fall through to author/
      // attach/populate. deleteMany is defensive — a reclaimable Path has no
      // concepts by construction (tx2 is atomic), but cascades clean up any partial
      // rows just in case. Keeping the id stable avoids orphaning rows that
      // reference it (e.g. a terminal RemediationJob from a prior failed run).
      await tx.concept.deleteMany({ where: { pathId: existing.id } });
      await tx.path.update({ where: { id: existing.id }, data: { status: PathStatus.building } });
      return { path: { id: existing.id, status: PathStatus.building }, created: true as const, reclaimed: true as const };
    }
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
    return { path, created: true as const, reclaimed: false as const };
  });

  if (!claim.created) {
    onTrace({ kind: 'info', label: 'path map exists', detail: { pathId: claim.path.id, status: claim.path.status } });
    return { pathId: claim.path.id, status: claim.path.status, created: false, reclaimed: false, holes: [] };
  }

  const pathId = claim.path.id;
  onTrace({
    kind: 'stage',
    label: claim.reclaimed ? 'path map reclaimed' : 'path map claimed',
    detail: { pathId, topic, reclaimed: claim.reclaimed },
  });

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
  onTrace({ kind: 'stage', label: 'path map built', detail: { pathId, status, holes, reclaimed: claim.reclaimed } });
  console.log('[map-ensure-path-map] built', { topic, pathId, status, holeCount: holes.length, reclaimed: claim.reclaimed });
  return { pathId, status, created: true, reclaimed: claim.reclaimed, holes };
}
