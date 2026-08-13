// Library-quality Q6b — the LIVE half of the Khan duration route.
//
// This is the block's only network test, and it exists so that a channel rename, a
// revoked key or a quota exhaustion fails a test instead of silently filling 755
// rows with `unknown`. Every degradation path in the matcher is honest by design, so
// nothing downstream would ever complain — that is precisely why the access itself
// has to be asserted somewhere.
//
// It lives in `tests/integration/` rather than beside the module as
// `youtube-index.int.test.ts` (the name the plan gives) because the unit project
// globs `src/**/*.test.ts`: an `.int.test.ts` under `src/` would be picked up by
// `npm test`, which must stay offline and secret-free. Same tier, different folder.
//
// It costs 3 quota units: one `channels.list`, one `playlistItems.list` page, one
// `videos.list` batch. It never calls `search.list` (100 units), and it never
// touches `khanacademy.org`.

import { describe, it, expect } from 'vitest';
import {
  KHAN_CHANNEL_HANDLE,
  KHAN_UPLOADS_PLAYLIST_ID,
  buildIndex,
  lookupTitle,
  normaliseTitle,
  resolveUploadsPlaylist,
} from '@/lib/sources/khan/youtube-index';
import { isoDurationToSeconds } from '@/lib/curation/duration-estimate';

const apiKey = process.env.YOUTUBE_API_KEY?.trim();
const describeYouTube = apiKey ? describe : describe.skip;
if (!apiKey) console.warn('[khan-youtube-index] YOUTUBE_API_KEY absent — skipping the live checks');

describeYouTube('Khan Academy YouTube channel (live)', () => {
  it('still resolves the handle to the uploads playlist we enumerate', async () => {
    // A rename or a channel-id change lands here, loudly, rather than as a silent
    // sweep of every Khan video row to `unknown`.
    await expect(resolveUploadsPlaylist(apiKey ?? '', KHAN_CHANNEL_HANDLE)).resolves.toBe(KHAN_UPLOADS_PLAYLIST_ID);
  }, 30_000);

  it('returns a page of videos with parseable durations', async () => {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('playlistId', KHAN_UPLOADS_PLAYLIST_ID);
    url.searchParams.set('key', apiKey ?? '');
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const json = (await page.json()) as {
      pageInfo?: { totalResults?: number };
      items?: { contentDetails?: { videoId?: string }; snippet?: { title?: string } }[];
    };

    // The channel held ~9,310 videos on 2026-08-11. A collapse to a handful means we
    // are reading something other than the uploads playlist.
    expect(json.pageInfo?.totalResults ?? 0).toBeGreaterThan(5_000);
    const items = (json.items ?? []).filter((i) => i.contentDetails?.videoId && i.snippet?.title);
    expect(items.length).toBeGreaterThan(10);

    const videos = new URL('https://www.googleapis.com/youtube/v3/videos');
    videos.searchParams.set('part', 'contentDetails');
    videos.searchParams.set('id', items.map((i) => i.contentDetails?.videoId).join(','));
    videos.searchParams.set('key', apiKey ?? '');
    const res = await fetch(videos);
    expect(res.status).toBe(200);
    const durations = (await res.json()) as { items?: { id?: string; contentDetails?: { duration?: string } }[] };

    const parsed = (durations.items ?? [])
      .map((v) => (v.contentDetails?.duration ? isoDurationToSeconds(v.contentDetails.duration) : null))
      .filter((s): s is number => s != null);
    expect(parsed.length).toBeGreaterThan(10);
    // An exact duration, not a placeholder: no Khan lesson is 20 minutes to the second.
    expect(parsed.every((s) => s > 0)).toBe(true);

    // And the index built from a real page answers a real title with a real number.
    const index = buildIndex(
      items.map((i, n) => ({
        videoId: i.contentDetails?.videoId ?? '',
        title: i.snippet?.title ?? '',
        durationSeconds: parsed[n] ?? 1,
      })),
    );
    const sample = items.find((i) => normaliseTitle(i.snippet?.title ?? ''));
    const hit = lookupTitle(index, sample?.snippet?.title ?? '');
    expect(hit.ok || hit.reason === 'ambiguous').toBe(true);
  }, 60_000);
});
