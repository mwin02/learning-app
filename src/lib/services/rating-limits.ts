// Free-beta A5: the vote route's per-user burst cap. Mirrors program-limits'
// programBurst in shape (count recent rows in a rolling window), but guards a
// different thing: not spend or manipulation — the @@unique([userId, resourceId])
// constraint already caps one account at a single vote per resource — just the DB
// write load of a signed-in client hammering POST /api/resources/[id]/rating.
//
// Signal: the user's ResourceRating rows whose updatedAt falls in the window. A
// re-vote (like→dislike) bumps updatedAt via @updatedAt, and a fresh vote sets it
// at create, so this counts recent write activity across resources. Known gap
// (accepted): clearing a vote deletes the row, so a like→clear→like churn on ONE
// resource isn't fully counted — but that vector's effect is bounded to a single
// resource and the client's busy-guard already throttles it; the fan-out this DOES
// bound is the one that costs real write load.

import { prisma } from '@/lib/db';
import { RATING_BURST_PER_HOUR, RATING_BURST_WINDOW_MS } from '@/lib/config';

export type RatingBurst = {
  allowed: boolean;
  used: number;
  limit: number;
};

export async function ratingBurst(userId: string, now: Date = new Date()): Promise<RatingBurst> {
  const used = await prisma.resourceRating.count({
    where: {
      userId,
      updatedAt: { gte: new Date(now.getTime() - RATING_BURST_WINDOW_MS) },
    },
  });
  return { allowed: used < RATING_BURST_PER_HOUR, used, limit: RATING_BURST_PER_HOUR };
}
