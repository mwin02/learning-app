// Phase 2.5h: the YouTube Data API discovery prong.
//
// The first rung of the per-concept sourcing ladder (web-fallback.ts) for VIDEO
// resources. Unlike the grounded-search prongs (which ask Gemini for URLs), this
// queries YouTube directly:
//   search.list  — keyword-retrieve candidate videos for the concept (100 quota
//                  units/call — the expensive one; oversample once, judge downstream)
//   videos.list  — statistics (views, likes) + contentDetails (duration) per video
//                  (1 unit) — deterministic, real numbers, no hallucinated URLs
//
// Returns rows shaped for the persistence tail (decompose → upsert): each carries
// its raw engagement signals + channelId so upsertResource resolves the channel's
// Source prior, persists the stats, and folds the engagement EvidenceSignal into
// trustScore. Concept tags are derived from title+description with the same helper
// the playlist router uses, so videos dedup and cross-attach like any other resource.
//
// Liveness is implicit (the API only returns live videos), and the sole hard gate
// is the view floor (meetsYoutubeViewFloor) — everything else is the soft trust
// signal. Quota/key failures degrade to an empty result so the ladder falls through
// to the grounded prongs rather than failing the build.

import type { Difficulty } from '@prisma/client';
import { deriveChildConcepts } from '@/lib/agents/decomposition/concepts';
import { googleapisFetchSignal, isoDurationToMinutes } from '@/lib/agents/decomposition/youtube';
import { meetsYoutubeViewFloor } from '@/lib/curation/youtube-signal';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// A video sourced via the Data API, shaped to feed upsertResource directly (the
// `youtube` field drives channel resolution + engagement trust there).
export type YoutubeSourcedResource = {
  url: string;
  title: string;
  type: 'video';
  difficulty: Difficulty;
  durationMin: number;
  summary: string;
  prerequisiteConcepts: string[];
  conceptsTaught: string[];
  youtube: { channelId: string; viewCount: number; likeCount: number | null };
};

type VideoDetail = {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  viewCount: number;
  likeCount: number | null;
  durationMin: number;
};

// Search YouTube for videos that teach one concept. `maxResults` is the search.list
// oversample (the judge downstream cuts it down); `difficulty` stamps the rows (the
// API can't tell us, so the caller passes the concept's target level, default
// intermediate). `denyUrls` drops already-seen videos (the ladder's deny-list).
export async function searchYouTubeForConcept(args: {
  topic: string;
  conceptTitle: string;
  maxResults: number;
  difficulty?: Difficulty;
  denyUrls?: string[];
  // Budget-fill Block 2: restrict search.list to videoDuration=long (>20m) so the
  // prong surfaces full lessons rather than more of the short clips the concept
  // already has. The attach ceiling (MAX_ATTACHABLE_DURATION_MIN) still drops any
  // whole-course monster this returns.
  preferSubstantial?: boolean;
  // Audit 2.2: the worker's per-job abort (deadline/shutdown), combined with the
  // per-fetch googleapis timeout so whichever fires first cancels the call.
  abortSignal?: AbortSignal;
}): Promise<YoutubeSourcedResource[]> {
  const { topic, conceptTitle, maxResults, difficulty = 'intermediate', denyUrls = [], preferSubstantial = false, abortSignal } = args;
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    console.log('[youtube-search] YOUTUBE_API_KEY not set — prong skipped', { conceptTitle });
    return [];
  }

  let videoIds: string[];
  try {
    videoIds = await searchVideoIds(`${conceptTitle} ${topic}`, maxResults, key, preferSubstantial, abortSignal);
  } catch (err) {
    console.warn('[youtube-search] search.list failed — prong degraded to empty', {
      conceptTitle,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (videoIds.length === 0) return [];

  let details: VideoDetail[];
  try {
    details = await fetchVideoDetails(videoIds, key, abortSignal);
  } catch (err) {
    console.warn('[youtube-search] videos.list failed — prong degraded to empty', {
      conceptTitle,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  // Hard gate: drop videos below the view floor (dead/garbage) and any already seen
  // this run. Everything surviving flows on as a soft trust signal.
  const deny = new Set(denyUrls);
  const kept = details.filter(
    (d) => meetsYoutubeViewFloor(d.viewCount) && !deny.has(watchUrl(d.videoId)),
  );
  if (kept.length === 0) {
    console.log('[youtube-search] no videos cleared the view floor', { conceptTitle, fetched: details.length });
    return [];
  }

  // Tag concepts from title+description (same helper the playlist router uses), so
  // these videos dedup and cross-attach like the rest of the library.
  const derived = await deriveChildConcepts({
    topic,
    parentConcepts: [conceptTitle],
    items: kept.map((d) => ({ ref: d.videoId, title: d.title, description: d.description })),
  });

  const rows = kept.map((d): YoutubeSourcedResource => {
    const tags = derived.get(d.videoId);
    return {
      url: watchUrl(d.videoId),
      title: d.title,
      type: 'video',
      difficulty,
      durationMin: d.durationMin,
      summary: d.description.trim().slice(0, 300) || d.title,
      prerequisiteConcepts: tags?.prerequisiteConcepts ?? [],
      // Never leave a video untagged — fall back to the concept we searched for.
      conceptsTaught: tags?.conceptsTaught?.length ? tags.conceptsTaught : [conceptTitle],
      youtube: { channelId: d.channelId, viewCount: d.viewCount, likeCount: d.likeCount },
    };
  });

  console.log('[youtube-search] sourced', {
    conceptTitle,
    searched: videoIds.length,
    aboveFloor: kept.length,
    returned: rows.length,
  });
  return rows;
}

const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

async function searchVideoIds(query: string, maxResults: number, key: string, preferSubstantial = false, abortSignal?: AbortSignal): Promise<string[]> {
  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('order', 'relevance');
  if (preferSubstantial) url.searchParams.set('videoDuration', 'long'); // >20 minutes

  url.searchParams.set('maxResults', String(Math.min(Math.max(maxResults, 1), 50)));
  url.searchParams.set('relevanceLanguage', 'en');
  url.searchParams.set('q', query);
  url.searchParams.set('key', key);

  const res = await fetch(url, { signal: googleapisFetchSignal(abortSignal) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeBody(res)}`);
  const json = (await res.json()) as YtSearchResponse;
  const ids: string[] = [];
  for (const item of json.items ?? []) {
    const id = item.id?.videoId;
    if (id) ids.push(id);
  }
  return ids;
}

async function fetchVideoDetails(videoIds: string[], key: string, abortSignal?: AbortSignal): Promise<VideoDetail[]> {
  const out: VideoDetail[] = [];
  // videos.list accepts up to 50 ids/call; search.list caps us at 50, so one batch.
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set('part', 'snippet,statistics,contentDetails');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('key', key);

    const res = await fetch(url, { signal: googleapisFetchSignal(abortSignal) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeBody(res)}`);
    const json = (await res.json()) as YtVideosResponse;
    for (const v of json.items ?? []) {
      if (!v.id || !v.snippet || !v.contentDetails?.duration) continue;
      const views = Number(v.statistics?.viewCount);
      out.push({
        videoId: v.id,
        title: v.snippet.title?.trim() || v.id,
        description: v.snippet.description ?? '',
        channelId: v.snippet.channelId ?? '',
        viewCount: Number.isFinite(views) ? views : 0,
        // likeCount absent === channel hides likes (distinct from zero likes).
        likeCount: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
        durationMin: isoDurationToMinutes(v.contentDetails.duration),
      });
    }
  }
  return out;
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

type YtSearchResponse = {
  items?: Array<{ id?: { videoId?: string } }>;
};

type YtVideosResponse = {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; description?: string; channelId?: string };
    statistics?: { viewCount?: string; likeCount?: string };
    contentDetails?: { duration?: string };
  }>;
};
