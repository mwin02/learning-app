// Reports R5: the free-tier Track-rebuild quota. Shaped like program-limits — the
// ONE place rebuild limits are decided, so routes ask and compare and the Stripe
// phase only teaches this file about plans.
//
// A rebuild is metered separately from Program creation (and reuses its UTC month
// boundary) because it is a DIFFERENT action with the same cost shape: no plan pass,
// but a full per-topic build. Counts the user's rebuild CourseRequests — the rows
// carrying `replacesTrackId` — created this UTC calendar month, excluding `failed`
// (a build that never produced a Track shouldn't burn quota, same rule as the
// program quota).

import { CourseRequestStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { monthStartUtc } from '@/lib/services/program-limits';
import { FREE_TRACK_REBUILDS_PER_MONTH, TRACK_REBUILD_DEDUP_WINDOW_MS } from '@/lib/config';

export type RebuildQuota = {
  allowed: boolean;
  used: number;
  limit: number;
};

export async function rebuildQuota(userId: string, now: Date = new Date()): Promise<RebuildQuota> {
  const used = await prisma.courseRequest.count({
    where: {
      userId,
      replacesTrackId: { not: null },
      createdAt: { gte: monthStartUtc(now) },
      status: { not: CourseRequestStatus.failed },
    },
  });
  return { allowed: used < FREE_TRACK_REBUILDS_PER_MONTH, used, limit: FREE_TRACK_REBUILDS_PER_MONTH };
}

// Duplicate-submit lookup: the caller's own rebuild of this slot that is STILL IN
// FLIGHT. Matching is on status, not just recency — there is no payload fingerprint
// here (unlike programInputHash), so recency alone cannot tell a double-submit from a
// second, legitimate rebuild request.
//
// A terminal rebuild must never match, and `fulfilled` is the case that matters:
// rebuild → build lands → learner reports two more dead links → rebuilds again is the
// exact loop this feature exists to serve, and deduping it would hand them the
// finished request's id (which R7 renders as "building…") while the build they asked
// for never happens. `failed` is excluded for the ordinary reason — retrying after a
// failure is legitimate.
//
// This runs BEFORE the single-in-flight precondition on purpose: that precondition
// refuses any in-flight rebuild of the slot, including the caller's own, so checking
// it first would turn a learner's own double-submit into a 409 and leave this lookup
// unreachable. Order is therefore: your own rebuild → 202 with its id; someone
// else's → `already_rebuilding`.
export async function findRecentRebuild(
  userId: string,
  programId: string,
  topic: string,
  now: Date = new Date(),
): Promise<{ id: string; status: CourseRequestStatus } | null> {
  return prisma.courseRequest.findFirst({
    where: {
      userId,
      programId,
      topic,
      replacesTrackId: { not: null },
      status: { in: [CourseRequestStatus.queued, CourseRequestStatus.running] },
      createdAt: { gte: new Date(now.getTime() - TRACK_REBUILD_DEDUP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
}
