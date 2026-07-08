// Phase 2.5g-1: the CourseRequest queue primitives — the durable handoff between
// the fire-and-forget route (enqueue + ack) and the out-of-band worker (claim →
// ensurePathMap → remediate → buildTrack → finish). Callers land later:
//   - enqueueCourseRequest  → the repointed /api/generate-path route (g-4)
//   - claimNextQueued / finishCourseRequest / reclaimStale → the worker (g-3)
//
// CourseRequest is intentionally NOT single-flighted (unlike RemediationJob): each
// learner request is its own row → its own per-learner Track snapshot. The
// expensive de-dup happens one layer down (ensurePathMap's advisory lock + the
// RemediationJob active-per-path index), so concurrent requests for the same
// building topic serialize there, not here.

import { CourseRequestStatus, Difficulty, Prisma, type CourseRequest } from '@prisma/client';
import { prisma } from '@/lib/db';
import { COURSE_REQUEST_STALE_MS } from '@/lib/config';
import { logWarn, type UsageSnapshot } from '@/lib/log';

export type EnqueueInput = {
  topic: string;
  userId?: string | null;
  priorKnowledge?: string | null;
  goal?: string | null;
  timeframeWeeks?: number | null;
  hoursPerWeek?: number | null;
  targetMastery?: Difficulty | null;
};

// Insert a `queued` request. The route calls this with the canonical (post
// topic-gate) slug + the learner's Track inputs, then acks immediately.
export async function enqueueCourseRequest(input: EnqueueInput): Promise<{ id: string }> {
  const row = await prisma.courseRequest.create({
    data: {
      topic: input.topic,
      userId: input.userId ?? null,
      priorKnowledge: input.priorKnowledge ?? null,
      goal: input.goal ?? null,
      timeframeWeeks: input.timeframeWeeks ?? null,
      hoursPerWeek: input.hoursPerWeek ?? null,
      targetMastery: input.targetMastery ?? null,
    },
    select: { id: true },
  });
  return { id: row.id };
}

// Atomically claim the oldest queued request → `running`, or return null if the
// queue is empty. FOR UPDATE SKIP LOCKED makes the claim safe even with >1 worker:
// two workers never grab the same row, and neither blocks on the other's locked
// row. The UPDATE...(SELECT...) is a single statement, so it's atomic without an
// explicit transaction. @updatedAt is a Prisma-client concern, so a raw write must
// set "updatedAt" itself. We RETURN only the id, then load a typed row.
export async function claimNextQueued(): Promise<CourseRequest | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "CourseRequest"
       SET status = 'running'::"CourseRequestStatus", "claimedAt" = now(), "updatedAt" = now()
     WHERE id = (
       SELECT id FROM "CourseRequest"
        WHERE status = 'queued'
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id
  `;
  if (rows.length === 0) return null;
  return prisma.courseRequest.findUniqueOrThrow({ where: { id: rows[0].id } });
}

// buildUsage: H3 (audit 9.4) — the job trace's accumulated token usage, written
// alongside the terminal state. Null/absent = not measured.
export type FinishInput =
  | { status: 'fulfilled'; trackId: string; buildUsage?: UsageSnapshot | null }
  | { status: 'failed'; error: string; buildUsage?: UsageSnapshot | null };

// Move a RUNNING request to a terminal state. Guarded on status='running' (hence
// updateMany, not update — `update` can't filter on status): a concurrent
// reclaimStale may have already bounced this row back to `queued` (worker thought
// dead but finished late), and we must NOT resurrect it to fulfilled/failed and
// corrupt the queue. A no-op (count 0) means exactly that; we log and report it.
export async function finishCourseRequest(
  id: string,
  input: FinishInput,
): Promise<{ finished: boolean }> {
  const buildUsage = input.buildUsage ?? Prisma.JsonNull;
  const { count } = await prisma.courseRequest.updateMany({
    where: { id, status: CourseRequestStatus.running },
    data:
      input.status === 'fulfilled'
        ? { status: CourseRequestStatus.fulfilled, trackId: input.trackId, buildUsage }
        : { status: CourseRequestStatus.failed, error: input.error, buildUsage },
  });
  if (count === 0) {
    logWarn('course-request.finish-noop', {
      id,
      attemptedStatus: input.status,
    });
  }
  return { finished: count > 0 };
}

// Reclaim requests stuck `running` past the stale threshold (a worker that died
// mid-run) by bouncing them back to `queued` so the next tick re-processes them.
// Returns how many were reclaimed.
//
// Known, accepted edge case: if a worker died AFTER buildTrack committed but
// BEFORE finishCourseRequest, requeue rebuilds a second Track. That's wasted work,
// not corruption — Tracks are immutable snapshots and duplicates are triaged
// manually — so we favor recovery (requeue) over stranding the request.
export async function reclaimStale(olderThanMs: number = COURSE_REQUEST_STALE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const { count } = await prisma.courseRequest.updateMany({
    where: { status: CourseRequestStatus.running, claimedAt: { lt: cutoff } },
    data: { status: CourseRequestStatus.queued, claimedAt: null },
  });
  if (count > 0) {
    logWarn('course-request.reclaimed-stale', { count, cutoff });
  }
  return count;
}
