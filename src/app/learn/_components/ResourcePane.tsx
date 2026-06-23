'use client';

// Phase 2.6 (learn UI), Block 3: the resource renderer for the lesson pane.
//
// A lesson carries a ranked resource list (primary core first, then alternates).
// The top-ranked resource is the "main" one, rendered by its deliveryMode:
//   - embed  → an <iframe> in a framed card with a *persistent* "open in new tab"
//              link, because cross-origin embeds (X-Frame-Options / frame-ancestors)
//              fail silently — a blank frame must always have an escape hatch.
//   - newtab / native → a prominent card that opens the resource in a new tab.
// Remaining resources are listed compactly below as open-in-new-tab rows.

import type { TrackResourceView } from '@/lib/track-view';
import type { LessonTypeKind } from '@/lib/course-home-model';
import { LessonTypeIcon } from './primitives';

// A single resource's icon kind: an embed delivery (or interactive type) shows the
// embed icon, video → video, everything else → the reading link icon.
function resourceTypeKind(r: TrackResourceView): LessonTypeKind {
  if (r.deliveryMode === 'embed') return 'embed';
  if (r.resource.type === 'video') return 'video';
  if (r.resource.type === 'interactive') return 'embed';
  return 'link';
}

function hostOf(url: string): string {
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
function toEmbedSrc(resource: TrackResourceView): string {
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

export function ResourcePane({ resources }: { resources: TrackResourceView[] }) {
  const [main, ...rest] = resources;

  if (!main) {
    return (
      <div className="card flex aspect-[16/9] items-center justify-center text-sm text-muted">
        No resource attached yet.
      </div>
    );
  }

  return (
    <div>
      {main.deliveryMode === 'embed' ? <EmbedPlayer resource={main} /> : <MainCard resource={main} />}
      {rest.length > 0 && <OtherResources resources={rest} />}
    </div>
  );
}

function EmbedPlayer({ resource }: { resource: TrackResourceView }) {
  const { url, title } = resource.resource;
  const src = toEmbedSrc(resource);
  // 16:9 for actual video (a video resource or a rewritten YouTube embed); the
  // taller 16:10 better suits embedded articles/widgets.
  const isVideo = resource.resource.type === 'video' || src.includes('/embed/');
  return (
    <figure className="card m-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-fill-soft px-4 py-2.5">
        <span className="meta-xs flex items-center gap-2 truncate text-faint">
          <LessonTypeIcon type={resourceTypeKind(resource)} />
          <span className="truncate">{hostOf(url)}</span>
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-none text-xs font-semibold text-brand hover:underline"
        >
          Open in new tab ↗
        </a>
      </div>
      <iframe
        src={src}
        title={title}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className={`block w-full bg-card ${isVideo ? 'aspect-video' : 'aspect-[16/10]'}`}
      />
      <figcaption className="border-t border-line-soft px-4 py-2.5 text-2xs text-muted">
        Some sites block embedding — if this stays blank,{' '}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand hover:underline"
        >
          open it in a new tab
        </a>
        .
      </figcaption>
    </figure>
  );
}

function MainCard({ resource }: { resource: TrackResourceView }) {
  const { url, title, type } = resource.resource;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="card flex items-center gap-4 p-5 hover:border-hairline"
    >
      <LessonTypeIcon type={resourceTypeKind(resource)} />
      <div className="min-w-0 flex-1">
        <div className="meta-xs text-faint">
          {type.toUpperCase()} · {hostOf(url)}
        </div>
        <div className="mt-1 truncate text-md font-semibold">{title}</div>
      </div>
      <span className="flex-none rounded-button bg-brand px-4 py-2 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(63,106,216,0.3)]">
        Open ↗
      </span>
    </a>
  );
}

function OtherResources({ resources }: { resources: TrackResourceView[] }) {
  return (
    <div className="mt-3.5">
      <div className="eyebrow mb-2 tracking-[1.5px] text-faint">MORE RESOURCES</div>
      <ul className="overflow-hidden rounded-card border border-line">
        {resources.map((r) => (
          <li key={r.id}>
            <a
              href={r.resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 border-b border-line-soft bg-card px-4 py-3 last:border-b-0 hover:bg-fill-soft"
            >
              <LessonTypeIcon type={resourceTypeKind(r)} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.resource.title}</div>
                <div className="meta-xs mt-0.5 text-faint">
                  {r.role === 'primary' ? 'Core' : 'Alternate'} · {hostOf(r.resource.url)}
                </div>
              </div>
              <span className="flex-none text-xs font-semibold text-brand">Open ↗</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
