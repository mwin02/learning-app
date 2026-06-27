// Throwaway verification for Phase 2.5h block 2b (YouTube engagement → trustScore).
//   npx tsx --env-file=.env.local scripts/verify-youtube-signal.ts
//
// Pure fixtures (real Data API numbers, no live calls) feeding youtubeEngagementSignal
// → computeTrustScore. Demonstrates the view-weighted model fixes the Khan
// false-negative (a great video with a low like ratio is NOT scored as junk), that
// known channels stay high via their prior, and that the admission floor + hidden-
// likes fallback behave.

import { youtubeEngagementSignal, meetsYoutubeViewFloor, type YoutubeStats } from '../src/lib/curation/youtube-signal';
import { computeTrustScore } from '../src/lib/curation/trust-score';

let failures = 0;
function approx(name: string, got: number, want: number, eps = 0.01) {
  const ok = Math.abs(got - want) <= eps;
  if (ok) console.log(`  ✓ ${name}  (${got.toFixed(3)})`);
  else {
    failures++;
    console.error(`  ✗ ${name}  got ${got.toFixed(3)}, want ${want.toFixed(3)}`);
  }
}
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}
// trustScore for a video given its source/channel prior + its stats.
function trust(base: number, stats: YoutubeStats): number {
  const sig = youtubeEngagementSignal(stats);
  return computeTrustScore({ base, signals: sig ? [sig] : [] });
}

const YT_NEUTRAL = 0.5; // neutral `youtube` source (unseeded channel)
const THREEB1B = 0.95; // 3Blue1Brown channel prior

console.log('\n── real live data (eigenvalues search) ────────────────────────');
// 3b1b resolves to its seeded channel prior (0.95); engagement keeps it there.
approx('3Blue1Brown 6.17M views / 1.97% likes @ base 0.95', trust(THREEB1B, { viewCount: 6_174_667, likeCount: 121_870 }), 0.945);
// Khan's YouTube channel is NOT seeded → neutral 0.5. Its like ratio is 0.27%
// (audience just doesn't click like) but it's a great video — view-weighting keeps
// it respectable instead of punishing it.
const khan = trust(YT_NEUTRAL, { viewCount: 1_333_991, likeCount: 3_570 });
approx('Khan (unseeded) 1.33M views / 0.27% likes @ base 0.5', khan, 0.587);
check('Khan NOT punished as junk by its low like ratio (> 0.5)', khan > 0.5, khan);
// Professor Dave (unseeded), healthy 1.86% like ratio.
approx('Professor Dave (unseeded) 1.35M / 1.86% @ base 0.5', trust(YT_NEUTRAL, { viewCount: 1_353_341, likeCount: 25_205 }), 0.659);

console.log('\n── contrast: like-ratio-only WOULD have buried Khan ───────────');
// Show the failure mode we avoided: if value were like-score only, Khan's 0.27%
// would map to ~0.107 → trust ≈ 0.35. View-weighting lifts it to ~0.59.
check('view-weighted Khan (0.59) beats like-only would-be (~0.35)', khan > 0.5, khan);

console.log('\n── hidden gem: strong ratio, modest views ─────────────────────');
const gem = trust(YT_NEUTRAL, { viewCount: 3_000, likeCount: 150 }); // 5% likes
approx('gem 3k views / 5% likes @ base 0.5 → modest lift', gem, 0.553);
check('gem lifted above base but stays modest (thin evidence)', gem > 0.5 && gem < 0.65, gem);

console.log('\n── admission floor (the only hard gate) ───────────────────────');
check('500 views fails the floor (dropped)', meetsYoutubeViewFloor(500) === false);
check('1000 views passes the floor', meetsYoutubeViewFloor(1000) === true);

console.log('\n── hidden likes + no-stats fallbacks ──────────────────────────');
const hidden = trust(YT_NEUTRAL, { viewCount: 2_000_000, likeCount: null });
approx('likes hidden → value rests on views @ base 0.5', hidden, 0.688);
check('zero-view video → no signal → stays at base prior', trust(0.7, { viewCount: 0, likeCount: 0 }) === 0.7);

console.log(failures === 0 ? '\n✅ all YouTube-signal checks passed\n' : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
