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

// Resource types that MIGHT be a container worth decomposing. This is only the
// discovery agent's first-pass type guess, so it's a candidate signal, not a
// verdict — the doc-TOC router fetches the page and decides whether it's truly
// an ordered lesson sequence (decompose) vs a single lesson or a reference
// index (keep whole as atomic). `docs` is included because official doc trees
// are prime decomposition targets; the router's reference_index classification
// is what keeps an API/method reference from being shattered into fragments.
// `book` (Block 0, container containment): an online book is a chaptered tree —
// exactly what doc-TOC decomposes — and classifying it atomic is how the 1,200m
// MML book got attached whole to concepts. Single-page/short `book` rows the
// router judges non-container reroute to atomic as before.
const CONTAINER_TYPES = new Set(['course', 'interactive', 'docs', 'book']);

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

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtu.be']);

function isYouTubeHost(host: string): boolean {
  return YOUTUBE_HOSTS.has(host);
}

// The playlist id of a YouTube URL, or null if it isn't a playlist context.
// A `list=` param marks a playlist (`/playlist?list=…` or `watch?v=…&list=…`).
function youtubePlaylistId(url: string): string | null {
  try {
    const list = new URL(url).searchParams.get('list');
    return list && list.trim().length > 0 ? list : null;
  } catch {
    return null;
  }
}

export function classify(resource: ClassifiableResource): DecompositionPlan {
  const host = hostnameOf(resource.url);

  if (host) {
    const paywalled = matchPaywalled(host);
    if (paywalled) return { kind: 'unsupported', platform: paywalled };

    // YouTube is decided by URL alone, NOT the resource's type label: a
    // playlist is a container; a single `watch?v=…` / `youtu.be/…` video is
    // atomic even when discovery mislabeled it `course` (the single-long-video
    // case). Resolving this here keeps a watch URL out of the doc-TOC scraper,
    // which would otherwise try to scrape a video page for "sections".
    if (isYouTubeHost(host)) {
      const playlistId = youtubePlaylistId(resource.url);
      return playlistId ? { kind: 'youtube_playlist', playlistId } : { kind: 'atomic' };
    }
  }

  // Non-YouTube container-shaped by type → the doc-TOC router decides whether
  // it's truly an ordered lesson sequence (decompose) or kept whole.
  if (CONTAINER_TYPES.has(resource.type)) return { kind: 'doc_toc' };

  return { kind: 'atomic' };
}
