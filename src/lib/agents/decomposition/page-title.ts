// The page's own title, reconciled against the one discovery invented.
//
// `Resource.title` on the sourcing path is free text the discovery model wrote
// (web-fallback's DiscoveredResourceSchema) — it describes what the model went
// LOOKING for, never the page it actually landed on. When those diverge the
// stored title names a sub-topic while the URL is a much larger container
// ("MIT OCW: The Analytics Edge - Lecture 6.2: Recommendation Systems" pointing
// at the course's whole 26-lecture notes index). doc-TOC already fetches the
// page and extracts its <title>; this module decides whether that fetched title
// is trustworthy enough to replace the invented one.
//
// The guard exists because the naive version is WORSE than doing nothing. Sites
// that block the crawler still return 200 with an interstitial — Khan Academy
// serves one titled "Client Challenge", and dead pages serve soft-404s like
// "Error - Page Missing". Trusting <title> blindly would overwrite plausible
// titles with those, and (because title feeds the embedding, see
// lib/ai/embeddings) re-embed every one of them onto garbage.
//
// So the rule is conservative in one direction on purpose: when in doubt, KEEP
// the existing title. A missed correction leaves today's behaviour; a bad
// correction corrupts the row and its vector.

// Titles served by bot-walls, consent gates and soft-404s. Matched against the
// whole title, not a prefix — several sites pad them ("Just a moment...").
//
// Deliberately loose, and deliberately NOT shared with the liveness validator
// (validation/validators/liveness.ts keeps its own, much tighter list). The cost
// asymmetries are opposite: here a false positive only means we keep the title we
// already had, so over-matching is nearly free; there it deletes a live resource.
// `/\berror\s*[-–—|]/` is the clearest example — it must fire on "Error - Page
// Missing", but a liveness check reusing it would kill a real lecture titled
// "Sampling and Standard Error | MIT OpenCourseWare".
const INTERSTITIAL = [
  /client challenge/i,
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /are you a robot/i,
  /enable javascript/i,
  /(^|\W)(40[0-9]|50[0-9])(\W|$)/,
  /page (not found|missing)/i,
  /not found/i,
  /forbidden/i,
  /^error\b/i,
  /\berror\s*[-–—|]/i,
];

// Words that carry no signal about WHICH page this is, so they can't be the
// evidence that a fetched title belongs to the stored URL.
const GENERIC = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by',
  'introduction', 'intro', 'guide', 'tutorial', 'docs', 'documentation', 'course',
  'courses', 'lesson', 'lessons', 'notes', 'page', 'pages', 'home', 'index',
  'learn', 'learning', 'overview', 'reference', 'www', 'com', 'org', 'edu', 'net',
  'html', 'htm', 'php', 'aspx', 'pdf',
]);

function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (w.length >= 3 && !GENERIC.has(w)) out.add(w);
  }
  return out;
}

// Site-suffix trimming. A full <title> is often the page name plus a chain of
// site furniture ("Lecture Notes | Database Systems | Electrical Engineering and
// Computer Science | MIT OpenCourseWare"). Those trailing segments are real but
// they are the same on every page of the site, so they add no discriminating
// signal and they DO dilute the embedding (title is a third of the embedded
// text). Keeping the first two segments preserves page + section, which is the
// part that identifies the page.
const MAX_TITLE_SEGMENTS = 2;
const MAX_TITLE_CHARS = 160;

// Host tokens used to recognise the site-name segment: khanacademy.org → ["khanacademy"],
// ocw.mit.edu → ["ocw", "mit"]. Public-suffix-ish and `www` parts carry no signal.
const HOST_NOISE = new Set(['www', 'com', 'org', 'net', 'edu', 'io', 'dev', 'co', 'uk']);

function hostTokens(url: string): string[] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  return host.split('.').filter((t) => t.length >= 3 && !HOST_NOISE.has(t));
}

// Is this segment the site's own name? Matched at WORD level, never substring: "mit" is a
// host token for ocw.mit.edu and "Limits" contains it, so a substring test would eat a
// real segment. "MIT OpenCourseWare" matches on the word "mit"; "Khan Academy" matches
// because its condensed form equals the host token "khanacademy".
function isSiteName(segment: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const words = segment.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const condensed = words.join('');
  return tokens.some((t) => condensed === t || words.includes(t));
}

export function cleanPageTitle(raw: string, url?: string): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const segments = normalized.split(/\s+[|»]\s+/).filter((s) => s.length > 0);

  // Strip trailing site-name segments first, so the segment cap spends its budget on
  // the part that identifies the PAGE. Without this, a two-segment title like
  // "Intro to SQL: Querying and managing data | Khan Academy" would survive the cap
  // intact and the "correction" would just bolt the site name onto a good title.
  const tokens = url ? hostTokens(url) : [];
  const trimmed = [...segments];
  while (trimmed.length > 1 && isSiteName(trimmed[trimmed.length - 1], tokens)) trimmed.pop();

  const kept = trimmed.length > MAX_TITLE_SEGMENTS ? trimmed.slice(0, MAX_TITLE_SEGMENTS) : trimmed;
  return kept
    .join(' | ')
    // Content-type markers some sites append ("… (video)", "… (article)"). Redundant with
    // Resource.type, and they would make otherwise-identical titles look like changes.
    .replace(/\s*\((video|article|practice|quiz|unit test)\)\s*$/i, '')
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

// Decide whether `fetched` should replace `stored` for the resource at `url`.
// Returns the cleaned replacement, or null to keep what's already stored.
//
// The positive test is deliberately weak — ONE shared content word with either
// the stored title or the URL's own path — because the whole point is that the
// stored title may be wrong. The URL slug is the independent anchor: a real page
// title nearly always shares vocabulary with its own path, while an interstitial
// shares nothing with either.
export function crediblePageTitle(
  fetched: string | undefined,
  stored: string,
  url: string,
): string | null {
  if (!fetched) return null;
  const cleaned = cleanPageTitle(fetched, url);
  if (cleaned.length < 3) return null;
  if (INTERSTITIAL.some((p) => p.test(cleaned))) return null;

  const candidate = words(cleaned);
  if (candidate.size === 0) return null;

  const anchor = new Set([...words(stored), ...words(pathOf(url))]);
  let shared = 0;
  for (const w of candidate) if (anchor.has(w)) shared += 1;
  if (shared === 0) return null;

  // Nothing to do when the fetched title only differs by site furniture we just
  // trimmed, or by case/spacing — saves a pointless write + re-embed.
  if (cleaned.toLowerCase() === stored.trim().toLowerCase()) return null;

  return cleaned;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
