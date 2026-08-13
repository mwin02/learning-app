// Library-quality Q6b — the pure, per-host duration estimators the re-derivation
// driver runs on fetched bytes. No I/O here, so every rule below is unit-testable
// against a fixture instead of a live site.
//
// The contract every function shares: an input it cannot read honestly yields
// `unknown`, never a number. That is the whole point of the block — P2's 20 was a
// confident value standing in for an absent measurement, and replacing it with a
// differently-derived confident value would repeat the mistake at a new number.
//
// Provenance follows the enum's own wording (`schema.prisma`): `extracted` is
// "stated by the artifact itself — link text, a TOC, or our own content", which is
// what a word or page count of the real document is. Container sums are `estimated`
// and belong to Q2's `containerDuration`, not here.

export type DurationEstimate =
  | { durationMin: number; durationSource: 'api' | 'extracted' }
  | { durationMin: null; durationSource: 'unknown' };

export const UNKNOWN: DurationEstimate = { durationMin: null, durationSource: 'unknown' };

// Math prose, not blog prose. 120 wpm is the low end of adult reading speed and is
// the rate B4 names for Khan's article bodies; Lamar's pages are the same kind of
// worked-through algebra, so they are read at the same rate rather than skimmed.
export const MATH_PROSE_WPM = 120;
// Each worked example is re-read and followed by hand, which no word count captures.
export const WORKED_EXAMPLE_MIN = 2;
// OCW lecture notes and decks. Measured 2026-08-11 against three PDFs: a 4-page
// number-theory lecture, a 7-page automata deck, a 25-page textbook chapter — at
// 4 min/page these land at 16 / 28 / 100 minutes, which brackets the values a human
// set by hand for the same shapes. Slides and dense notes differ, and this single
// constant does not distinguish them; it is an estimate and is stamped as one.
export const OCW_PDF_MIN_PER_PAGE = 4;
// A word count this small is page chrome, not content: an OCW resource page whose
// body is a PDF viewer counts ~270 words of navigation. Below this we have read
// nothing, and saying so beats reporting a 2-minute lecture.
export const MIN_CONTENT_WORDS = 400;

// ── HTML → words ─────────────────────────────────────────────────────────────

// Deliberately crude: strip the two element bodies that are code rather than prose,
// drop tags and entities, and count anything left holding a letter or digit. A
// proper parser would cost a dependency to move a reading-time estimate by a few
// percent, which is well inside the estimate's own error.
export function countWords(html: string): number {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');
  return text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

function countWorkedExamples(html: string): number {
  return (html.match(/\bExample\s+\d+/g) ?? []).length;
}

export function readingMinutes(words: number, workedExamples = 0): number {
  return Math.max(1, Math.round(words / MATH_PROSE_WPM) + workedExamples * WORKED_EXAMPLE_MIN);
}

// ── tutorial.math.lamar.edu ──────────────────────────────────────────────────

// Static HTML with the lesson text inline (verified 2026-08-11: the whole body is
// content — `id="content"` sits at the top of the document and nothing before it
// contributes a word), so reading time is deterministic from the bytes we fetched.
export function estimateLamarArticle(html: string): DurationEstimate {
  const words = countWords(html);
  if (words < MIN_CONTENT_WORDS) return UNKNOWN;
  return { durationMin: readingMinutes(words, countWorkedExamples(html)), durationSource: 'extracted' };
}

// ── ocw.mit.edu ──────────────────────────────────────────────────────────────

// An OCW resource page is a shell around one artifact. Which artifact decides how it
// is measured, so the driver asks the page what it holds before deciding.
export function ocwArtifact(html: string): { kind: 'youtube'; videoId: string } | { kind: 'pdf'; href: string } | null {
  const video = /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/|"videoId"\s*:\s*")([A-Za-z0-9_-]{11})/.exec(html);
  if (video) return { kind: 'youtube', videoId: video[1] };
  const pdf = /href="([^"]+\.pdf)"/i.exec(html);
  if (pdf) return { kind: 'pdf', href: pdf[1] };
  return null;
}

// Page count straight out of the PDF's object table. `/Type /Page` (not `/Pages`)
// marks one leaf page each; the trailing negative lookahead is what keeps the
// `/Pages` tree nodes out of the count. Read from the raw bytes as latin1 so a
// binary stream can never throw a decoding error mid-count.
export function pdfPageCount(bytes: Uint8Array): number | null {
  const raw = Buffer.from(bytes).toString('latin1');
  const pages = (raw.match(/\/Type\s*\/Page(?![s/\w])/g) ?? []).length;
  return pages > 0 ? pages : null;
}

export function estimateOcwPdf(bytes: Uint8Array): DurationEstimate {
  const pages = pdfPageCount(bytes);
  if (pages == null) return UNKNOWN;
  return { durationMin: Math.max(1, pages * OCW_PDF_MIN_PER_PAGE), durationSource: 'extracted' };
}

// The fallback when the page holds neither a video nor a PDF: its own prose. Guarded
// by MIN_CONTENT_WORDS because most OCW resource pages have no prose worth reading.
export function estimateOcwPage(html: string): DurationEstimate {
  const words = countWords(html);
  if (words < MIN_CONTENT_WORDS) return UNKNOWN;
  return { durationMin: readingMinutes(words), durationSource: 'extracted' };
}

// ── ISO-8601 ─────────────────────────────────────────────────────────────────

// Strict, unlike `isoDurationToMinutes` in decomposition/youtube.ts, which returns 1
// for an unparseable string. A silent 1 is the same species of lie as the 20 this
// block exists to remove, so here an unreadable duration is `null` and the caller
// records `unknown`.
export function isoDurationToSeconds(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

// Whole minutes, floor 1: a 2:09 short film is 2 minutes, and a 40-second one is 1,
// never 0 — a zero would read downstream as "no time at all".
export function secondsToMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

// ── Q10: attribution by re-derivation ────────────────────────────────────────

// The rule for the 786 rows that carry a number stamped `unknown`. `Resource` has
// no per-field audit trail and the `ResourceReport.resolution` trail reaches ZERO
// of them (measured 2026-08-12), so these rows are unattributable by construction
// — not merely inconvenient to attribute. The only honest exception is a number a
// source can be asked to produce again: re-measure it independently, and stamp the
// provenance ONLY if the stored number is exactly what the source says today.
//
// Exactly, not approximately. A tolerance would let a hand-set 22 borrow the
// provenance of a 21-minute video, which is the manufactured confidence this whole
// plan exists to remove — and "close to a measurement" is a shape argument, the
// species of reasoning the brief forbids outright.
//
// It is applied only where a match is evidence rather than coincidence: the legacy
// YouTube path wrote precisely this number from precisely this API call
// (`decomposition/youtube.ts`), so equality means the row came from there. It is
// deliberately NOT applied to word-count estimators, which were written for Q6b
// and never ran on a legacy row — an equality there would be a collision, not a
// trail.
export function attributeByRederivation(
  storedMin: number | null,
  rederivedMin: number | null,
): 'api' | null {
  if (storedMin == null || rederivedMin == null) return null;
  return storedMin === rederivedMin ? 'api' : null;
}
