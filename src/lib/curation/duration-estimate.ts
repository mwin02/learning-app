import { inflateSync } from 'node:zlib';

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

// ── static documentation and tutorial prose ──────────────────────────────────

// Reference documentation is read faster than a worked derivation and slower than a
// blog: unfamiliar API names and precise wording stop a reader that math prose does
// not, but nothing here is derived by hand the way MATH_PROSE_WPM assumes.
export const TECH_PROSE_WPM = 180;
// A code sample is read, not skimmed, and it is not prose — counting its tokens at a
// reading rate is meaningless (a `<pre>` of 300 tokens is not 100 seconds of reading),
// but dropping it to zero under-reads a reference page that is a quarter code by
// volume. Charged per block instead, which is what a reader actually stops for.
export const CODE_BLOCK_MIN = 0.5;

// Measured 2026-08-16 against 16 pages across the eight group-1 hosts. Code is 24–31%
// of raw words on react.dev, docs.python.org, freecodecamp, scikit-learn and MDN — the
// inflation `countWords` alone would carry, since it strips script/style/nav but not
// `<pre>`/`<code>`. Against the stored values that were NOT the placeholder, this
// formula lands within ~10%: python `controlflow` 40 vs 45, freecodecamp `decorator`
// 36 vs 35, MDN `Variables` 28 vs 30, OpenStax `3-3-differentiation` 46 vs 45.
export function estimateDocsArticle(html: string): DurationEstimate {
  const prose = countWords(html.replace(/<pre[\s\S]*?<\/pre>/gi, ' ').replace(/<code[\s\S]*?<\/code>/gi, ' '));
  if (prose < MIN_CONTENT_WORDS) return UNKNOWN;
  const blocks = (html.match(/<pre\b/gi) ?? []).length;
  return {
    durationMin: Math.max(1, Math.round(prose / TECH_PROSE_WPM + blocks * CODE_BLOCK_MIN)),
    durationSource: 'extracted',
  };
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

// Words in the PDF's own content streams. Deflate-decode each stream and pull the
// strings handed to the text-showing operators; `latin1` throughout so a stream that
// is an image, or that we cannot inflate, degrades to garbage rather than throwing.
//
// Counted as CHARACTERS / 5.5, not as whitespace-separated tokens, because a LaTeX
// deck positions every glyph individually — Boyd's 6.079 slides emit
// `(P) (o) (i) (n) (t)` and a token count reads 8,160 "words" on a 32-page deck that
// holds about 1,900. Characters survive both encodings.
const CHARS_PER_WORD = 5.5;

export function pdfWords(bytes: Uint8Array): number | null {
  const raw = Buffer.from(bytes).toString('latin1');
  let chars = 0;
  let found = false;
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    let text: string;
    try {
      text = inflateSync(chunk).toString('latin1');
    } catch {
      text = chunk.toString('latin1');
    }
    for (const s of text.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      found = true;
      chars += s[0].slice(1, -1).replace(/[^A-Za-z0-9]/g, '').length;
    }
  }
  return found ? Math.round(chars / CHARS_PER_WORD) : null;
}

// A slide deck and a chapter of lecture notes are both PDFs and are read at completely
// different speeds, which `OCW_PDF_MIN_PER_PAGE` cannot express — its own comment says
// so. Words per page separates them cleanly, with a wide empty band in between:
// measured 2026-08-16 over the 14 decks this rule was written for, 6.045J ran 52–73
// words a page and 6.079 ran 38–71, while the dense notes and textbook chapters the
// 4 min/page constant was calibrated against sit in the hundreds. 120 is the midpoint
// of that gap, comfortably clear of both sides.
export const SLIDE_MAX_WORDS_PER_PAGE = 120;

export function estimateOcwPdf(bytes: Uint8Array): DurationEstimate {
  const pages = pdfPageCount(bytes);
  if (pages == null) return UNKNOWN;
  // A deck is measured the same way every other text artifact in this file is — by the
  // words it actually contains. Costing one at 4 min/page read Nancy Lynch's 53-slide
  // automata deck as 212 minutes against a stored 40; its 3,475 words are 29.
  const words = pdfWords(bytes);
  if (words != null && words / pages < SLIDE_MAX_WORDS_PER_PAGE) {
    if (words < MIN_CONTENT_WORDS) return UNKNOWN;
    return { durationMin: readingMinutes(words), durationSource: 'extracted' };
  }
  return { durationMin: Math.max(1, pages * OCW_PDF_MIN_PER_PAGE), durationSource: 'extracted' };
}

// The fallback when the page holds neither a video nor a PDF: its own prose. Guarded
// by MIN_CONTENT_WORDS because most OCW resource pages have no prose worth reading.
export function estimateOcwPage(html: string): DurationEstimate {
  const words = countWords(html);
  if (words < MIN_CONTENT_WORDS) return UNKNOWN;
  return { durationMin: readingMinutes(words), durationSource: 'extracted' };
}

// ── generated:// — content we authored ───────────────────────────────────────

// Read at ordinary prose speed, not MATH_PROSE_WPM: an on-ramp lesson is orientation
// writing, not a worked derivation. Clamped to a short window so a generated lesson
// reliably wins the on-ramp duration bias (2g-1) over long sourced courses, and never
// reports an implausible sub-minute or half-hour read.
export const ONRAMP_MIN_READ = 5;
export const ONRAMP_MAX_READ = 20;
export const ONRAMP_READING_WPM = 200;

// Lives here rather than in `generate-onramp.ts` because it now has two callers: the
// generator that writes new on-ramp rows, and the backfill for the rows written before
// that path stamped a provenance. Both must produce the same number for the same text,
// or a backfilled lesson and a fresh one disagree about identical content.
export function onrampReadingMinutes(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const mins = Math.round(words / ONRAMP_READING_WPM);
  return Math.min(ONRAMP_MAX_READ, Math.max(ONRAMP_MIN_READ, mins));
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
