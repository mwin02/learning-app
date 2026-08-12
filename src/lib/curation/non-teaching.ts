// Library quality Q8 (plan defect P6) — does this page TEACH, or is it furniture?
//
// Decomposition admits a container's navigation and marketing pages as pickable atomic
// leaves: `About the course`, `Course Prerequisites`, Khan's `Feedback` / `Checkpoint` /
// `What's next?`, the Python tutorial's `Appendix` / `What Now?` / `Whetting Your
// Appetite`, an OCW exams index, a College Board interview. Each one then competes with
// real lessons in retrieval, on a shelf where it is semantically adjacent to them.
//
// ⚠️ THE ERROR BUDGET IS ONE-SIDED, and the rules below are shaped by that, not by
// coverage. Missing a piece of furniture costs one bad candidate among thousands;
// FLAGGING A REAL LESSON removes it from every learner's retrieval, permanently and
// invisibly. So every rule matches a WHOLE title (or a whole separator-delimited
// segment), never a substring: "Feedback" is furniture, "Control Systems - Feedback
// Loops" is a lesson, and no rule here can confuse the two. An ambiguous title passes
// through as teaching BY CONSTRUCTION — that is the design, not a limitation.
//
// The second tier exists for the titles no phrase list can settle. It pairs a WEAK title
// signal with the junk-leaf signal the TopicCentroid model already documents ("the
// absolute similarity is NOT a filing signal … though it doubles as a decent junk-leaf
// detector"): a row that reads like furniture AND sits nowhere near any topic's centroid.
// Neither half fires alone. Callers that have no centroid number (decomposition, which
// classifies before the row exists) simply get tier one.

export type NonTeachingReason =
  | 'furniture-title' // the whole title is a known furniture phrase
  | 'furniture-tail' // the title's last segment is an index/admin page name
  | 'furniture-url' // the URL's last path segment is a known furniture slug
  | 'promo-interview' // a course-marketing interview, not a lesson
  | 'junk-leaf'; // weak title signal corroborated by a low centroid similarity

export type NonTeachingVerdict =
  | { nonTeaching: false }
  | { nonTeaching: true; reason: NonTeachingReason };

export type NonTeachingInput = {
  title: string;
  summary?: string;
  url?: string;
  // Absolute cosine to the row's best topic centroid, when the caller has one. Enables
  // tier two only; its absence never changes a tier-one verdict.
  centroidSimilarity?: number | null;
};

// Below this, a row sits outside every topic's cluster. The T2 calibration measured
// genuine rows at p50 0.768 against their own centroid and the library's junk samples at
// d≈0.4+ (sim ≈0.6), so 0.55 is well under the honest population, not a midpoint.
export const JUNK_CENTROID_FLOOR = 0.55;

// Whole normalized title. Every entry is a page that carries no instruction: course
// front matter, book front/back matter, site chrome.
const FURNITURE_TITLES = new Set([
  'about the course',
  'about this course',
  'about the author',
  'about the authors',
  'about the book',
  'course prerequisites',
  'prerequisites',
  'feedback',
  'checkpoint',
  'whats next',
  'summary whats next',
  'what now',
  'appendix',
  'appendices',
  'whetting your appetite',
  'table of contents',
  'contents',
  'glossary',
  'preface',
  'foreword',
  'acknowledgements',
  'acknowledgments',
  'errata',
  'colophon',
  'copyright',
  'license',
  'licence',
  'bibliography',
  'credits',
  'contributors',
  'exams',
  'syllabus',
  'course info',
  'course information',
  'course description',
  'welcome',
  'orientation',
  'download course materials',
  'related resources',
  'instructor insights',
  'privacy policy',
  'terms of use',
  'terms of service',
  'site map',
  'donate',
  'subscribe',
]);

// A STRICTER list, applied to the last separator-delimited segment of a longer title
// ("MIT OCW 6.034: Artificial Intelligence - Exams"). Deliberately smaller than the set
// above: a trailing word is weaker evidence than a whole title, so anything that could
// name a real lesson is left out — `feedback` (a control-systems lesson), `contents`,
// `index`, `exam` singular, `welcome`.
const FURNITURE_TAILS = new Set([
  'exams',
  'syllabus',
  'course info',
  'course information',
  'about the course',
  'course prerequisites',
  'table of contents',
  'download course materials',
  'related resources',
  'instructor insights',
]);

// Whole last path segment (extension stripped, hyphens read as spaces). Never `index` —
// `index.html` is how real container pages are addressed.
const FURNITURE_SLUGS = new Set([
  'about the course',
  'course prerequisites',
  'feedback',
  'checkpoint',
  'whats next',
  'what next',
  'whatnow',
  'what now',
  'appendix',
  'appetite',
  'table of contents',
  'glossary',
  'syllabus',
  'exams',
  'errata',
  'colophon',
  'copyright',
  'license',
  'contributors',
]);

// Tier two's weak half: a furniture phrase appearing anywhere in the title as whole
// words. On its own this is NOT evidence — "Why These Prerequisites Matter" and "The
// Feedback Loop in Control Systems" both match — which is exactly why it is only ever
// read together with a low centroid similarity.
const WEAK_PHRASES = [
  'prerequisite',
  'prerequisites',
  'about the course',
  'about this course',
  'course overview',
  'whats next',
  'feedback',
  'checkpoint',
  'welcome',
  'syllabus',
];

const SEPARATORS = /\s+[-–—|:]\s+/;

// Everything the rules match on runs through here first: lowercase, punctuation dropped,
// whitespace collapsed. Apostrophes are ELIDED rather than spaced, or "What's next?"
// would normalize to `what s next` and miss the `whats next` key — which is precisely how
// the Khan copy of it slipped through the first measured run.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lastPathSegment(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const segment = path.slice(path.lastIndexOf('/') + 1);
    return segment ? normalize(segment.replace(/\.[a-z0-9]+$/i, '')) : null;
  } catch {
    // Non-URL `url` values exist (generated:// rows parse, but a malformed one must not
    // throw out of a classifier that the decomposition path calls per child).
    return null;
  }
}

export function classifyNonTeaching(input: NonTeachingInput): NonTeachingVerdict {
  const title = normalize(input.title);
  if (!title) return { nonTeaching: false };

  if (FURNITURE_TITLES.has(title)) return { nonTeaching: true, reason: 'furniture-title' };

  const segments = input.title.split(SEPARATORS);
  if (segments.length > 1) {
    const tail = normalize(segments[segments.length - 1]);
    if (FURNITURE_TAILS.has(tail)) return { nonTeaching: true, reason: 'furniture-tail' };
  }

  // A course's promotional interview with a partner organisation. Narrow on purpose:
  // both halves must be present, so an interview that TEACHES ("Interview with a data
  // scientist: how regression is used") is untouched unless it also names the board.
  if (/\binterviews?\b/.test(title) && /\bcollege board\b/.test(title)) {
    return { nonTeaching: true, reason: 'promo-interview' };
  }

  const slug = input.url ? lastPathSegment(input.url) : null;
  if (slug && FURNITURE_SLUGS.has(slug)) return { nonTeaching: true, reason: 'furniture-url' };

  const sim = input.centroidSimilarity;
  if (typeof sim === 'number' && sim < JUNK_CENTROID_FLOOR && hasWeakPhrase(title)) {
    return { nonTeaching: true, reason: 'junk-leaf' };
  }

  return { nonTeaching: false };
}

function hasWeakPhrase(normalizedTitle: string): boolean {
  const padded = ` ${normalizedTitle} `;
  return WEAK_PHRASES.some((phrase) => padded.includes(` ${phrase} `));
}
