// Frontend redesign Block 5: pure resource-display helpers, extracted from
// ResourcePane so the notebook lesson pane and the old /learn pane share one
// implementation of the URL/type logic. No behavior change.

import type { TrackResourceView } from '@/lib/track-view';
import type { LessonTypeKind } from '@/lib/course-home-model';

// A single resource's icon kind: an embed delivery (or interactive type) shows the
// embed icon, video → video, everything else → the reading link icon.
export function resourceTypeKind(r: TrackResourceView): LessonTypeKind {
  if (r.deliveryMode === 'embed') return 'embed';
  if (r.resource.type === 'video') return 'video';
  if (r.resource.type === 'interactive') return 'embed';
  return 'link';
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// segmentRef may carry a start offset (seconds) for time-coded video; accept the
// common key spellings and ignore anything else.
function startSeconds(seg: unknown): number | null {
  if (seg && typeof seg === 'object') {
    const o = seg as Record<string, unknown>;
    for (const k of ['start', 'startSeconds', 't', 'from']) {
      const v = o[k];
      if (typeof v === 'number' && v > 0) return Math.floor(v);
    }
  }
  return null;
}

// The iframe src. A YouTube watch / youtu.be / shorts URL can't be framed directly
// (X-Frame-Options) — it must be rewritten to the /embed/ form, which is built to be
// embedded. Everything else is framed as-is (and may still be blocked cross-origin,
// hence the persistent fallback link). Uses youtube-nocookie for privacy.
export function toEmbedSrc(resource: TrackResourceView): string {
  const { url } = resource.resource;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    let id: string | null = null;
    if (host === 'youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (u.pathname.startsWith('/embed/')) return url; // already embeddable
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] ?? null;
    } else if (host === 'youtu.be') {
      id = u.pathname.slice(1) || null;
    }
    if (!id) return url;
    const start = startSeconds(resource.segmentRef);
    return `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`;
  } catch {
    return url;
  }
}
