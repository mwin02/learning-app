// Unit tests for YouTube engagement → trustScore (Phase 2.5h block 2b). Pure fixtures
// (real Data API numbers, no live calls) feeding youtubeEngagementSignal →
// computeTrustScore. No DB, no LLM. Migrated from scripts/verify-youtube-signal.ts (R2).
//
// Demonstrates the view-weighted model fixes the Khan false-negative (a great video
// with a low like ratio is NOT scored as junk), that known channels stay high via their
// prior, and that the admission floor + hidden-likes fallback behave.
import { describe, it, expect } from 'vitest';
import { youtubeEngagementSignal, meetsYoutubeViewFloor, type YoutubeStats } from '@/lib/curation/youtube-signal';
import { computeTrustScore } from '@/lib/curation/trust-score';

// Faithful port of the script's approx() (|got - want| <= eps), default eps 0.01.
const close = (got: number, want: number, eps = 0.01) => expect(Math.abs(got - want)).toBeLessThanOrEqual(eps);
// trustScore for a video given its source/channel prior + its stats.
const trust = (base: number, stats: YoutubeStats): number => {
  const sig = youtubeEngagementSignal(stats);
  return computeTrustScore({ base, signals: sig ? [sig] : [] });
};

const YT_NEUTRAL = 0.5; // neutral `youtube` source (unseeded channel)
const THREEB1B = 0.95; // 3Blue1Brown channel prior

describe('real live data (eigenvalues search)', () => {
  it('3Blue1Brown 6.17M views / 1.97% likes @ base 0.95', () =>
    close(trust(THREEB1B, { viewCount: 6_174_667, likeCount: 121_870 }), 0.945));
  // Khan's YouTube channel is NOT seeded → neutral 0.5. Its like ratio is 0.27%
  // (audience just doesn't click like) but it's a great video — view-weighting keeps
  // it respectable instead of punishing it.
  const khan = trust(YT_NEUTRAL, { viewCount: 1_333_991, likeCount: 3_570 });
  it('Khan (unseeded) 1.33M views / 0.27% likes @ base 0.5 → 0.587', () => close(khan, 0.587));
  it('Khan NOT punished as junk by its low like ratio (> 0.5)', () => expect(khan).toBeGreaterThan(0.5));
  it('Professor Dave (unseeded) 1.35M / 1.86% @ base 0.5 → 0.659', () =>
    close(trust(YT_NEUTRAL, { viewCount: 1_353_341, likeCount: 25_205 }), 0.659));

  // Contrast: like-ratio-only WOULD have buried Khan (0.27% → ~0.107 → trust ≈ 0.35).
  it('view-weighted Khan (0.59) beats like-only would-be (~0.35)', () => expect(khan).toBeGreaterThan(0.5));
});

describe('hidden gem: strong ratio, modest views', () => {
  const gem = trust(YT_NEUTRAL, { viewCount: 3_000, likeCount: 150 }); // 5% likes
  it('gem 3k views / 5% likes @ base 0.5 → modest lift (0.553)', () => close(gem, 0.553));
  it('gem lifted above base but stays modest (thin evidence)', () => {
    expect(gem).toBeGreaterThan(0.5);
    expect(gem).toBeLessThan(0.65);
  });
});

describe('admission floor (the only hard gate)', () => {
  it('500 views fails the floor (dropped)', () => expect(meetsYoutubeViewFloor(500)).toBe(false));
  it('1000 views passes the floor', () => expect(meetsYoutubeViewFloor(1000)).toBe(true));
});

describe('hidden likes + no-stats fallbacks', () => {
  it('likes hidden → value rests on views @ base 0.5 → 0.688', () =>
    close(trust(YT_NEUTRAL, { viewCount: 2_000_000, likeCount: null }), 0.688));
  it('zero-view video → no signal → stays at base prior', () =>
    expect(trust(0.7, { viewCount: 0, likeCount: 0 })).toBe(0.7));
});
