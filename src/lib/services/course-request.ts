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
import { COURSE_REQUEST_MAX_ATTEMPTS, COURSE_REQUEST_STALE_MS } from '@/lib/config';
import { log, logWarn, type UsageSnapshot } from '@/lib/log';

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

// Atomically claim the oldest ELIGIBLE queued request → `running`, or return null
// if none. Eligible = queued AND (nextAttemptAt is null or past due) — a requeued
// row sits out its backoff, then rejoins at its original createdAt priority (D10).
// The @@index([status, createdAt]) still serves the scan; the nextAttemptAt filter
// is a cheap residual predicate on a small queue. FOR UPDATE SKIP LOCKED makes the
// claim safe even with >1 worker: two workers never grab the same row, and neither
// blocks on the other's locked row. The UPDATE...(SELECT...) is a single statement,
// so it's atomic without an explicit transaction. Each claim burns one attempt
// (D3: the ONLY place attempts increments) and stamps claimedBy with the caller's
// worker identity (D6, observability only). @updatedAt is a Prisma-client concern,
// so a raw write must set "updatedAt" itself. We RETURN only the id, then load a
// typed row.
export async function claimNextQueued(workerId?: string): Promise<CourseRequest | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "CourseRequest"
       SET status = 'running'::"CourseRequestStatus", "claimedAt" = now(),
           attempts = attempts + 1, "claimedBy" = ${workerId ?? null},
           "updatedAt" = now()
     WHERE id = (
       SELECT id FROM "CourseRequest"
        WHERE status = 'queued'
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
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

// Workers-A1 (D2/D5): bounce a RUNNING request back to `queued` with a backoff —
// the worker calls this instead of failing when the topic is contended (another
// worker's build in flight) or on graceful shutdown (A2). Guarded on
// status='running' like finishCourseRequest, and for the same reason: a concurrent
// reclaimStale may have already bounced the row, and a second bounce would stomp
// its state. Cap check first (D5): a row that has already burned
// COURSE_REQUEST_MAX_ATTEMPTS claims is failed terminally instead — attempts
// increments at claim, and the caller owns the running claim, so the read isn't
// racing anyone.
export async function requeueCourseRequest(
  id: string,
  opts: { delayMs: number; reason: string },
): Promise<{ requeued: boolean; failedAtCap: boolean }> {
  const row = await prisma.courseRequest.findUnique({ where: { id }, select: { attempts: true } });
  if (row && row.attempts >= COURSE_REQUEST_MAX_ATTEMPTS) {
    const { finished } = await finishCourseRequest(id, {
      status: 'failed',
      error: `max attempts (${COURSE_REQUEST_MAX_ATTEMPTS}) exhausted — last: ${opts.reason}`,
    });
    return { requeued: false, failedAtCap: finished };
  }
  const { count } = await prisma.courseRequest.updateMany({
    where: { id, status: CourseRequestStatus.running },
    data: {
      status: CourseRequestStatus.queued,
      claimedAt: null,
      nextAttemptAt: new Date(Date.now() + opts.delayMs),
    },
  });
  if (count === 0) {
    logWarn('course-request.requeue-noop', { id, reason: opts.reason });
  } else {
    log('course-request.requeued', { id, delayMs: opts.delayMs, reason: opts.reason });
  }
  return { requeued: count > 0, failedAtCap: false };
}

// Reclaim requests stuck `running` past the stale threshold (a worker that died
// mid-run). Rows under the attempts cap bounce back to `queued` with
// nextAttemptAt = null — a dead worker's request retries immediately, no backoff.
// Rows AT the cap (D5: a poison request crash-looping through reclaim) go terminal
// `failed` with a diagnostic instead of requeueing forever. Returns how many rows
// were reclaimed (requeued + failed).
//
// Known, accepted edge case: if a worker died AFTER buildTrack committed but
// BEFORE finishCourseRequest, requeue rebuilds a second Track. That's wasted work,
// not corruption — Tracks are immutable snapshots and duplicates are triaged
// manually — so we favor recovery (requeue) over stranding the request.
export async function reclaimStale(olderThanMs: number = COURSE_REQUEST_STALE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = { status: CourseRequestStatus.running, claimedAt: { lt: cutoff } };
  const [{ count: requeued }, { count: failed }] = await Promise.all([
    prisma.courseRequest.updateMany({
      where: { ...stale, attempts: { lt: COURSE_REQUEST_MAX_ATTEMPTS } },
      data: { status: CourseRequestStatus.queued, claimedAt: null, nextAttemptAt: null },
    }),
    prisma.courseRequest.updateMany({
      where: { ...stale, attempts: { gte: COURSE_REQUEST_MAX_ATTEMPTS } },
      data: {
        status: CourseRequestStatus.failed,
        error: `max attempts (${COURSE_REQUEST_MAX_ATTEMPTS}) exhausted — last: stale claim reclaimed`,
      },
    }),
  ]);
  if (requeued + failed > 0) {
    logWarn('course-request.reclaimed-stale', { count: requeued + failed, requeued, failed, cutoff });
  }
  return requeued + failed;
}
