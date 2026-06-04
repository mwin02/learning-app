// Phase 2.5b — decomposition router (classification stage).
//
// Deterministic, no-LLM classification of a discovered/seed Resource into a
// decomposition *plan*: how (if at all) it should be exploded into atomic
// children. Classification is by URL shape + resource type only — cheap and
// auditable. The plan kinds map onto the routers that 2.5b-2/-3 implement:
//
//   atomic           — a single pickable unit (single video, article, docs page,
//                      book). No children; upserts as today.
//   youtube_playlist — a YouTube playlist; children are its videos (2.5b-2).
//   doc_toc          — a non-YouTube course/doc tree; children are its sections
//                      (2.5b-3, via fetch + LLM TOC extract + URL validation).
//   unsupported      — a known paywalled platform we deliberately don't crawl.
//
// In 2.5b-1 only `atomic` produces children-free upserts; every other kind is
// routed to `human_review` by decompose() until its router ships.

export type DecompositionPlan =
  | { kind: 'atomic' }
  | { kind: 'youtube_playlist'; playlistId: string }
  | { kind: 'doc_toc' }
  | { kind: 'unsupported'; platform: string };

export type ClassifiableResource = {
  url: string;
  type: string;
};

// Hostnames whose main content sits behind login/paywall. We never crawl these;
// the container row exists but stays unpickable.
const PAYWALLED_PLATFORMS: Record<string, string> = {
  'coursera.org': 'Coursera',
  'udemy.com': 'Udemy',
  'edx.org': 'edX',
  'datacamp.com': 'DataCamp',
  'pluralsight.com': 'Pluralsight',
  'linkedin.com': 'LinkedIn Learning',
  'codecademy.com': 'Codecademy',
};

// Resource types that, when not a single atomic unit, denote a container whose
// parts should be delivered as separate lessons.
const CONTAINER_TYPES = new Set(['course', 'interactive']);

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function matchPaywalled(host: string): string | null {
  for (const [domain, name] of Object.entries(PAYWALLED_PLATFORMS)) {
    if (host === domain || host.endsWith('.' + domain)) return name;
  }
  return null;
}

function youtubePlaylistId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
  // A `list=` param marks a playlist context. A bare `watch?v=…` single video
  // (no list) is atomic; `watch?v=…&list=…` and `/playlist?list=…` are the
  // playlist container.
  const list = parsed.searchParams.get('list');
  return list && list.trim().length > 0 ? list : null;
}

export function classify(resource: ClassifiableResource): DecompositionPlan {
  const host = hostnameOf(resource.url);

  if (host) {
    const paywalled = matchPaywalled(host);
    if (paywalled) return { kind: 'unsupported', platform: paywalled };
  }

  const playlistId = youtubePlaylistId(resource.url);
  if (playlistId) return { kind: 'youtube_playlist', playlistId };

  // Container-shaped by type (and not a single YouTube video, handled above):
  // route to the doc-TOC scraper.
  if (CONTAINER_TYPES.has(resource.type)) return { kind: 'doc_toc' };

  return { kind: 'atomic' };
}
