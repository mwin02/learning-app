// Library-quality Q6b — Khan Academy durations, obtained without asking Khan.
//
// ⚠️ NOTHING IN THIS FILE MAY FETCH `khanacademy.org` OR `kastatic.org`. Q6a found
// that every path on that host, `/robots.txt` included, answers an automated client
// with a bot-detection challenge — so there is no crawling policy we are able to
// read and therefore no permission we are able to claim. The persisted-query client
// the plan originally specified was withdrawn for that reason, not because it
// stopped working. The route here needs none of Khan's own infrastructure: Khan
// publishes the same videos on its own YouTube channel, and the official Data API
// answers with exact ISO-8601 durations.
//
// Cost, measured 2026-08-11: the uploads playlist `UU4a-Gbdw7vOaccHmFo40b9g` holds
// ~9,310 videos. `playlistItems.list` is 1 quota unit per 50-item page and
// `videos.list` 1 unit per 50 ids, so the whole channel is ~200 units against a
// 10,000/day default. `search.list` would be 100 units for ONE call and is never
// used here.
//
// The residual risk is matching, not access, and it degrades one way: our rows carry
// a lesson title while YouTube titles carry breadcrumbs. A title that matches no
// entry, or more than one, is `unknown`. Never a guess, and above all never 20 —
// a wrong number is indistinguishable from a measured one once it is in the column,
// which is the exact failure this plan exists to remove.

// The timeout budget is the pipeline's shared one, but taken from `config` rather
// than from `decomposition/youtube`'s `googleapisFetchSignal`: that module reaches
// `@/lib/db` through its concept deriver, which would drag a database connection
// into a matcher whose whole job is pure string work — and into its unit test.
import { GOOGLEAPIS_FETCH_TIMEOUT_MS } from '@/lib/config';
import { isoDurationToSeconds } from '@/lib/curation/duration-estimate';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// Khan Academy's uploads playlist. Every channel's uploads playlist is its channel
// id with the `UC` prefix rewritten to `UU`; resolving it from the handle costs a
// `channels.list` call, which the integration test spends so a rename fails loudly
// there rather than silently here.
export const KHAN_UPLOADS_PLAYLIST_ID = 'UU4a-Gbdw7vOaccHmFo40b9g';
export const KHAN_CHANNEL_HANDLE = 'khanacademy';

export type KhanVideo = { videoId: string; title: string; durationSeconds: number };
export type KhanIndex = Map<string, KhanVideo[]>;

export type TitleLookup =
  | { ok: true; video: KhanVideo }
  | { ok: false; reason: 'no-match' | 'ambiguous'; candidates: number };

/**
 * The normalisation rule, and it is deliberately lossy in one direction only.
 *
 * YouTube titles are breadcrumbs — `"One-time pad | Journey into cryptography |
 * Computer Science | Khan Academy"` — and the lesson title is the segment before the
 * first `|`. Our own rows sometimes carry a breadcrumb too (`"The quadratic formula
 * | Algebra (video)"`), so both sides run through the same function and neither side
 * is trusted to be the clean one.
 *
 * After the breadcrumb cut: diacritics folded, case dropped, `&` spelled out (Khan
 * writes both "and" and "&" for the same lesson), every remaining non-alphanumeric
 * run collapsed to a single space. Losing punctuation merges distinct titles into
 * one key more often than it splits one title across two — and a merge surfaces as
 * `ambiguous`, which records `unknown`, while a split surfaces as `no-match`, which
 * also records `unknown`. Both failure modes land on the honest answer.
 */
export function normaliseTitle(raw: string): string {
  return raw
    .split('|')[0]
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function buildIndex(videos: KhanVideo[]): KhanIndex {
  const index: KhanIndex = new Map();
  for (const video of videos) {
    const key = normaliseTitle(video.title);
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), video]);
  }
  return index;
}

/**
 * Two videos sharing a normalised title are NOT resolved by preferring one — Khan
 * re-uploads lessons and the duplicates differ in length, so picking either is a
 * coin flip wearing a measurement's clothes. `ambiguous` is the honest report.
 */
export function lookupTitle(index: KhanIndex, title: string): TitleLookup {
  const matches = index.get(normaliseTitle(title)) ?? [];
  if (matches.length === 1) return { ok: true, video: matches[0] };
  return {
    ok: false,
    reason: matches.length === 0 ? 'no-match' : 'ambiguous',
    candidates: matches.length,
  };
}

// ── live enumeration ─────────────────────────────────────────────────────────

/** Resolves a channel handle to its uploads playlist. 1 quota unit. */
export async function resolveUploadsPlaylist(apiKey: string, handle: string): Promise<string> {
  const url = new URL(`${API_BASE}/channels`);
  url.searchParams.set('part', 'contentDetails');
  url.searchParams.set('forHandle', handle);
  url.searchParams.set('key', apiKey);
  const json = await getJson<ChannelsResponse>(url);
  const playlistId = json.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error(`channel handle @${handle} resolved no uploads playlist`);
  return playlistId;
}

/**
 * Enumerates the whole uploads playlist and pairs every video with its duration.
 * Pages of 50 (1 unit each) and duration batches of 50 (1 unit each) — the two
 * cheapest calls the Data API has.
 *
 * A video whose duration does not parse is DROPPED rather than defaulted, so it can
 * only ever produce a `no-match` downstream. A partial index is a correct index of
 * fewer videos; an index with an invented duration in it is not an index.
 */
export async function fetchKhanUploads(args: {
  apiKey: string;
  playlistId?: string;
  onProgress?: (fetched: number, total: number) => void;
}): Promise<{ videos: KhanVideo[]; quotaUnits: number }> {
  const { apiKey, playlistId = KHAN_UPLOADS_PLAYLIST_ID, onProgress } = args;
  const items: { videoId: string; title: string }[] = [];
  let pageToken: string | undefined;
  let total = 0;
  let quotaUnits = 0;

  do {
    const url = new URL(`${API_BASE}/playlistItems`);
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const json = await getJson<PlaylistItemsResponse>(url);
    quotaUnits += 1;
    total = json.pageInfo?.totalResults ?? total;
    for (const it of json.items ?? []) {
      const videoId = it.contentDetails?.videoId;
      const title = it.snippet?.title?.trim();
      if (videoId && title) items.push({ videoId, title });
    }
    onProgress?.(items.length, total);
    pageToken = json.nextPageToken;
  } while (pageToken);

  const videos: KhanVideo[] = [];
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('id', batch.map((b) => b.videoId).join(','));
    url.searchParams.set('key', apiKey);

    const json = await getJson<VideosResponse>(url);
    quotaUnits += 1;
    const titles = new Map(batch.map((b) => [b.videoId, b.title]));
    for (const v of json.items ?? []) {
      const seconds = v.contentDetails?.duration ? isoDurationToSeconds(v.contentDetails.duration) : null;
      const title = v.id ? titles.get(v.id) : undefined;
      if (v.id && title && seconds != null) videos.push({ videoId: v.id, title, durationSeconds: seconds });
    }
  }

  return { videos, quotaUnits };
}

// Any non-200 throws rather than returning an empty page, because an empty page is
// indistinguishable from "this playlist ended" — and a quota error silently read as
// "the channel has no more videos" would fill 755 rows with `unknown` while looking
// like a clean run. Failing loudly is the acceptance criterion.
async function getJson<T>(url: URL): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(GOOGLEAPIS_FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`youtube ${url.pathname} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

type ChannelsResponse = {
  items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
};
type PlaylistItemsResponse = {
  nextPageToken?: string;
  pageInfo?: { totalResults?: number };
  items?: Array<{ contentDetails?: { videoId?: string }; snippet?: { title?: string } }>;
};
type VideosResponse = { items?: Array<{ id?: string; contentDetails?: { duration?: string } }> };
