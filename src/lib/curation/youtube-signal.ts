// Phase 2.5h: YouTube engagement → trustScore evidence.
//
// Turns a video's raw Data API statistics (viewCount, likeCount) into an
// EvidenceSignal that the trust-score seam (trust-score.ts) blends onto the
// source/channel prior. See the YT_* knobs in config.ts for the calibration
// rationale (view-weighted, like ratio as a soft modifier, capped weight).
//
// Two separate concerns, deliberately not conflated:
//   - meetsYoutubeViewFloor — admission. A video below YT_MIN_VIEWS is dropped by
//     the sourcing prong (dead/garbage), never sourced. This is the only hard gate.
//   - youtubeEngagementSignal — quality. For an admitted video, the soft signal
//     that nudges its trustScore. Likes may be hidden by a channel; then the signal
//     rests on views alone (likeScore falls out of the blend, re-normalized).
//
// Pure + dependency-light (config only) so the colocated youtube-signal.test.ts can
// exercise it without the API or a DB.

import {
  YT_VIEW_SAT,
  YT_TARGET_LIKE_RATIO,
  YT_VIEW_WEIGHT,
  YT_SIGNAL_WEIGHT,
  YT_MIN_VIEWS,
} from '@/lib/config';
import type { EvidenceSignal } from '@/lib/curation/trust-score';

export type YoutubeStats = {
  viewCount: number;
  // null when the channel hides likes — the signal then rests on views alone.
  likeCount: number | null;
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// Admission gate: is this video viewed enough to source at all? The single hard
// filter; everything above it flows in as a soft trust signal.
export function meetsYoutubeViewFloor(viewCount: number): boolean {
  return Number.isFinite(viewCount) && viewCount >= YT_MIN_VIEWS;
}

// log10(views+1) normalized to [0,1] against the saturation point. Drives both the
// popularity component of `value` and the whole signal's `confidence`.
function viewScore(viewCount: number): number {
  if (!Number.isFinite(viewCount) || viewCount <= 0) return 0;
  return clamp01(Math.log10(viewCount + 1) / Math.log10(YT_VIEW_SAT));
}

// The engagement EvidenceSignal for an admitted video, or null when there are no
// usable stats (no views) — a null signal means "no evidence", so trustScore stays
// at the source/channel prior.
export function youtubeEngagementSignal(stats: YoutubeStats): EvidenceSignal | null {
  const vScore = viewScore(stats.viewCount);
  if (vScore <= 0) return null;

  let value: number;
  if (stats.likeCount != null && stats.viewCount > 0) {
    const likeScore = clamp01(stats.likeCount / stats.viewCount / YT_TARGET_LIKE_RATIO);
    value = YT_VIEW_WEIGHT * vScore + (1 - YT_VIEW_WEIGHT) * likeScore;
  } else {
    // Likes hidden: the like term drops out; value rests on views alone (rather than
    // silently scoring likeScore=0, which would punish channels that hide likes).
    value = vScore;
  }

  return { value, confidence: vScore, weight: YT_SIGNAL_WEIGHT };
}
