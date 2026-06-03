// Phase 2.5b-2 — YouTube playlist router.
//
// Explodes a playlist container into atomic per-video child Resources via the
// YouTube Data API v3 (plain server-side API key, no OAuth). Two calls:
//   playlistItems.list — titles, descriptions, positions, video ids (paginated)
//   videos.list        — contentDetails.duration per video (batched)
// Private/deleted entries are dropped. Children re-derive their own concepts
// (decision A) via concepts.ts. No new npm dependency — plain fetch keeps the
// Cloud Run migration clean.
//
// Outcome mapping (consumed by decompose()):
//   ok                       → status 'decomposed' (+ children)
//   key missing / API error  → status 'pending'      (auto-retryable)
//   playlist 404 / no usable videos → status 'human_review' (needs curation)

import { deriveChildConcepts } from './concepts';
import type { ChildInput } from './decompose';
import { YOUTUBE_PLAYLIST_MAX_CHILDREN } from '@/lib/config';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UNAVAILABLE_TITLES = new Set(['Private video', 'Deleted video']);

export type PlaylistResult =
  | { ok: true; children: ChildInput[]; truncated: boolean }
  | { ok: false; outcome: 'pending' | 'human_review'; reason: string };

type RawItem = { videoId: string; title: string; description: string; position: number };

class PlaylistNotFound extends Error {}

export async function decomposePlaylist(args: {
  playlistId: string;
  topic: string;
  difficulty: string;
  parentConcepts: string[];
}): Promise<PlaylistResult> {
  const { playlistId, topic, difficulty, parentConcepts } = args;

  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    return { ok: false, outcome: 'pending', reason: 'YOUTUBE_API_KEY not set' };
  }

  let items: RawItem[];
  let truncated: boolean;
  try {
    const fetched = await fetchPlaylistItems(playlistId, key, YOUTUBE_PLAYLIST_MAX_CHILDREN);
    items = fetched.items;
    truncated = fetched.truncated;
  } catch (err) {
    if (err instanceof PlaylistNotFound) {
      return { ok: false, outcome: 'human_review', reason: 'playlist not found' };
    }
    return { ok: false, outcome: 'pending', reason: `playlistItems fetch failed: ${(err as Error).message}` };
  }

  if (items.length === 0) {
    return { ok: false, outcome: 'human_review', reason: 'playlist has no usable (public) videos' };
  }

  let durations: Map<string, number>;
  try {
    durations = await fetchDurations(items.map((i) => i.videoId), key);
  } catch (err) {
    return { ok: false, outcome: 'pending', reason: `videos fetch failed: ${(err as Error).message}` };
  }

  const concepts = await deriveChildConcepts({
    topic,
    parentConcepts,
    items: items.map((it) => ({ ref: it.videoId, title: it.title, description: it.description })),
  });

  const children: ChildInput[] = items.map((it) => {
    const derived = concepts.get(it.videoId);
    return {
      url: `https://www.youtube.com/watch?v=${it.videoId}`,
      title: it.title,
      type: 'video',
      difficulty,
      durationMin: durations.get(it.videoId) ?? 1,
      summary: it.description.trim().slice(0, 300) || it.title,
      // Fall back to the parent's concepts only if derivation dropped this ref —
      // never leave a child with no conceptsTaught (dedup relies on it).
      prerequisiteConcepts: derived?.prerequisiteConcepts ?? [],
      conceptsTaught:
        derived?.conceptsTaught ?? (parentConcepts.length > 0 ? parentConcepts : [topic]),
      orderInParent: it.position,
    };
  });

  return { ok: true, children, truncated };
}

// ── Data API calls ───────────────────────────────────────────────────────────

async function fetchPlaylistItems(
  playlistId: string,
  key: string,
  cap: number,
): Promise<{ items: RawItem[]; truncated: boolean }> {
  const items: RawItem[] = [];
  let pageToken: string | undefined;
  let sawMoreThanCap = false;

  do {
    const url = new URL(`${API_BASE}/playlistItems`);
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('key', key);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url);
    if (res.status === 404) throw new PlaylistNotFound(playlistId);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeBody(res)}`);
    const json = (await res.json()) as YtPlaylistItemsResponse;

    for (const it of json.items ?? []) {
      const videoId = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId;
      const title = it.snippet?.title?.trim() ?? '';
      // Skip private/deleted (sentinel titles) and any entry missing a video id.
      if (!videoId || UNAVAILABLE_TITLES.has(title)) continue;
      if (items.length >= cap) {
        sawMoreThanCap = true;
        break;
      }
      items.push({
        videoId,
        title: title || `Video ${it.snippet?.position ?? items.length + 1}`,
        description: it.snippet?.description ?? '',
        position: it.snippet?.position ?? items.length,
      });
    }

    pageToken = items.length >= cap ? undefined : json.nextPageToken;
  } while (pageToken);

  if (sawMoreThanCap) {
    console.log('[youtube] playlist truncated to cap', { playlistId, cap });
  }
  return { items, truncated: sawMoreThanCap };
}

async function fetchDurations(videoIds: string[], key: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // videos.list accepts up to 50 ids per call; our cap keeps us at one batch,
  // but chunk defensively in case the cap is raised later.
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('key', key);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeBody(res)}`);
    const json = (await res.json()) as YtVideosResponse;
    for (const v of json.items ?? []) {
      if (v.id && v.contentDetails?.duration) {
        out.set(v.id, isoDurationToMinutes(v.contentDetails.duration));
      }
    }
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

// ISO-8601 duration (e.g. "PT1H2M30S", "PT15M", "PT45S") → whole minutes, min 1.
export function isoDurationToMinutes(iso: string): number {
  const m = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 1;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  const seconds = Number(m[3] ?? 0);
  const total = Math.round(hours * 60 + minutes + seconds / 60);
  return Math.max(1, total);
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

// Minimal shapes for the fields we read from the Data API responses.
type YtPlaylistItemsResponse = {
  nextPageToken?: string;
  items?: Array<{
    contentDetails?: { videoId?: string };
    snippet?: {
      title?: string;
      description?: string;
      position?: number;
      resourceId?: { videoId?: string };
    };
  }>;
};

type YtVideosResponse = {
  items?: Array<{ id?: string; contentDetails?: { duration?: string } }>;
};
