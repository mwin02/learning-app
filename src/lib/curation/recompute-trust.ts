// Free-beta A1: the trustScore recompute seam.
//
// Rebuilds a resource's FULL evidence list from persisted raw data — the YouTube
// engagement stats (viewCount/likeCount columns, exactly why they were persisted
// in 2.5h) and the ResourceRating vote counts — and re-runs computeTrustScore over
// the Source prior, persisting the result. Called by the vote route (A2) after
// each vote write; kept a lib function so a backfill script can batch-call it.
// Returns the inputs alongside the score so A4's eviction check can branch on
// score + vote count without re-querying.
//
// Known accepted drift: a decomposed child inherits its parent's BLENDED trust at
// create time but not the raw viewCount/likeCount (upsert-resource.ts createChild),
// so the first recompute of such a child rebuilds from source prior + votes only,
// dropping the parent container's engagement contribution. Accepted by design
// (A1 discussion): the channel prior still holds via the inherited sourceId, and a
// direct learner vote is stronger evidence than the parent's view count.

import { prisma } from '@/lib/db';
import { computeTrustScore, type EvidenceSignal } from '@/lib/curation/trust-score';
import { youtubeEngagementSignal } from '@/lib/curation/youtube-signal';
import { voteSignal } from '@/lib/curation/vote-signal';

export type RecomputeTrustResult = {
  trustScore: number;
  likes: number;
  dislikes: number;
};

// Recompute + persist a resource's trustScore. Null for an unknown id (batch
// callers skip; the vote route 404s before ever writing a vote for one).
export async function recomputeResourceTrust(resourceId: string): Promise<RecomputeTrustResult | null> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: {
      viewCount: true,
      likeCount: true,
      source: { select: { trustScore: true } },
    },
  });
  if (!resource) return null;

  const byValue = await prisma.resourceRating.groupBy({
    by: ['value'],
    where: { resourceId },
    _count: { _all: true },
  });
  const likes = byValue.find((g) => g.value === 1)?._count._all ?? 0;
  const dislikes = byValue.find((g) => g.value === -1)?._count._all ?? 0;

  const signals: EvidenceSignal[] = [];
  // viewCount null = not a YouTube-API-sourced row (or an inheriting child) — no
  // engagement evidence. Same stats → same signal as the original upsert-time call.
  if (resource.viewCount != null) {
    const engagement = youtubeEngagementSignal({
      viewCount: resource.viewCount,
      likeCount: resource.likeCount,
    });
    if (engagement) signals.push(engagement);
  }
  const votes = voteSignal(likes, dislikes);
  if (votes) signals.push(votes);

  const trustScore = computeTrustScore({ base: resource.source.trustScore, signals });
  await prisma.resource.update({
    where: { id: resourceId },
    data: { trustScore },
  });

  return { trustScore, likes, dislikes };
}
