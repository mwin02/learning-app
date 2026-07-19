// Free-beta A2: DB helpers for resource ratings (mirrors progress-db's shape —
// thin, typed, no HTTP concerns). The write path lives in the rating route; this
// is the read side the lesson page uses to hydrate the viewer's own votes
// server-side (one query per lesson render, no per-resource client fetches).

import { prisma } from '@/lib/db';

export type VoteValue = 1 | -1;

// The viewer's votes across one lesson's resources, keyed by resourceId.
// Missing key = no vote. Empty for an empty id list (no query).
export async function loadViewerVotes(
  userId: string,
  resourceIds: string[]
): Promise<Record<string, VoteValue>> {
  if (resourceIds.length === 0) return {};
  const rows = await prisma.resourceRating.findMany({
    where: { userId, resourceId: { in: resourceIds } },
    select: { resourceId: true, value: true },
  });
  return Object.fromEntries(rows.map((r) => [r.resourceId, r.value as VoteValue]));
}
