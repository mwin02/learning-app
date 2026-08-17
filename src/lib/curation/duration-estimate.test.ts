import { describe, it, expect } from 'vitest';
import {
  attributeByRederivation,
  countWords,
  estimateLamarArticle,
  estimateDocsArticle,
  estimateOcwPage,
  estimateOcwPdf,
  isoDurationToSeconds,
  MATH_PROSE_WPM,
  MIN_CONTENT_WORDS,
  OCW_PDF_MIN_PER_PAGE,
  ocwArtifact,
  pdfPageCount,
  pdfWords,
  TECH_PROSE_WPM,
  CODE_BLOCK_MIN,
  SLIDE_MAX_WORDS_PER_PAGE,
  readingMinutes,
  secondsToMinutes,
  WORKED_EXAMPLE_MIN,
} from './duration-estimate';
import { containerDuration } from '@/lib/agents/decomposition/duration-rules';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const page = (body: string) => `<html><head></head><body>${body}</body></html>`;

describe('countWords', () => {
  it('drops script, style and chrome elements', () => {
    const html = page(
      `<nav>${words(50)}</nav><script>const a = 1; ${words(50)}</script>` +
        `<style>.x{color:red}</style><footer>${words(50)}</footer><p>alpha beta gamma</p>`,
    );
    expect(countWords(html)).toBe(3);
  });

  it('does not count punctuation or entities as words', () => {
    expect(countWords('<p>one &mdash; two &#8212; ... three</p>')).toBe(3);
  });
});

describe('readingMinutes', () => {
  it('reads math prose at the slow rate', () => {
    expect(readingMinutes(MATH_PROSE_WPM * 10)).toBe(10);
  });

  it('adds time per worked example', () => {
    expect(readingMinutes(MATH_PROSE_WPM * 10, 3)).toBe(10 + 3 * WORKED_EXAMPLE_MIN);
  });

  it('never returns zero for a very short page', () => {
    expect(readingMinutes(5)).toBe(1);
  });
});

describe('estimateLamarArticle', () => {
  it('extracts a reading time from the page body', () => {
    const html = page(`<div id="content"><p>${words(2400)}</p><h3>Example 1</h3><h3>Example 2</h3></div>`);
    expect(estimateLamarArticle(html)).toEqual({
      durationMin: 20 + 2 * WORKED_EXAMPLE_MIN,
      durationSource: 'extracted',
    });
  });

  it('degrades to unknown when the page carries no content, never to a number', () => {
    const html = page(`<div id="content"><p>${words(MIN_CONTENT_WORDS - 1)}</p></div>`);
    expect(estimateLamarArticle(html)).toEqual({ durationMin: null, durationSource: 'unknown' });
  });
});

describe('estimateDocsArticle', () => {
  it('does not read code blocks as prose', () => {
    const prose = words(TECH_PROSE_WPM * 10);
    const withCode = page(`<p>${prose}</p><pre>${words(2000)}</pre>`);
    // 10 minutes of prose + one block, not 10 + 2000 words of "reading".
    expect(estimateDocsArticle(withCode)).toEqual({
      durationMin: Math.round(10 + CODE_BLOCK_MIN),
      durationSource: 'extracted',
    });
  });

  it('charges per code block rather than ignoring them', () => {
    const prose = `<p>${words(TECH_PROSE_WPM * 10)}</p>`;
    const blocks = Array.from({ length: 8 }, () => `<pre>${words(50)}</pre>`).join('');
    expect(estimateDocsArticle(page(prose + blocks)).durationMin).toBe(Math.round(10 + 8 * CODE_BLOCK_MIN));
  });

  it('degrades to unknown when the page is chrome, never to a number', () => {
    expect(estimateDocsArticle(page(`<p>${words(MIN_CONTENT_WORDS - 1)}</p>`))).toEqual({
      durationMin: null,
      durationSource: 'unknown',
    });
  });

  it('does not let a wall of code make a stub look substantial', () => {
    // 100 words of prose around a huge sample: still unknown, because we read nothing.
    expect(estimateDocsArticle(page(`<p>${words(100)}</p><pre>${words(9000)}</pre>`))).toEqual({
      durationMin: null,
      durationSource: 'unknown',
    });
  });
});

describe('ocwArtifact', () => {
  it('finds an embedded video id', () => {
    expect(ocwArtifact(page('<iframe src="https://www.youtube.com/embed/iOZVbILaIZc"></iframe>'))).toEqual({
      kind: 'youtube',
      videoId: 'iOZVbILaIZc',
    });
  });

  it('prefers a video over a PDF — a lecture page links its own transcript', () => {
    const html = page('<a href="/courses/x/y_iOZVbILaIZc.pdf">notes</a><iframe src="https://youtu.be/iOZVbILaIZc"></iframe>');
    expect(ocwArtifact(html)).toEqual({ kind: 'youtube', videoId: 'iOZVbILaIZc' });
  });

  it('falls back to the linked PDF', () => {
    expect(ocwArtifact(page('<a href="/courses/x/MIT6_045JS11_lec14.pdf">notes</a>'))).toEqual({
      kind: 'pdf',
      href: '/courses/x/MIT6_045JS11_lec14.pdf',
    });
  });

  it('returns null when the page wraps neither', () => {
    expect(ocwArtifact(page('<p>nothing here</p>'))).toBeNull();
  });
});

describe('pdfPageCount', () => {
  const pdf = (n: number) =>
    new TextEncoder().encode(
      `%PDF-1.4\n1 0 obj<</Type /Pages /Count ${n}>>endobj\n` +
        Array.from({ length: n }, (_, i) => `${i + 2} 0 obj<</Type /Page /Parent 1 0 R>>endobj`).join('\n'),
    );

  it('counts leaf pages and not the page-tree node', () => {
    expect(pdfPageCount(pdf(7))).toBe(7);
  });

  it('estimates from the page count', () => {
    expect(estimateOcwPdf(pdf(7))).toEqual({ durationMin: 7 * OCW_PDF_MIN_PER_PAGE, durationSource: 'extracted' });
  });

  it('is unknown, not zero, when the bytes are not a readable PDF', () => {
    expect(pdfPageCount(new TextEncoder().encode('<html>404</html>'))).toBeNull();
    expect(estimateOcwPdf(new TextEncoder().encode('<html>404</html>'))).toEqual({
      durationMin: null,
      durationSource: 'unknown',
    });
  });
});

describe('estimateOcwPdf — slide decks vs dense notes', () => {
  // An uncompressed content stream, which `pdfWords` falls back to reading when the
  // bytes will not inflate. `wordsPerPage` words of five letters each are spread over
  // `pages` pages, so the fixture lands on either side of SLIDE_MAX_WORDS_PER_PAGE.
  const pdf = (pages: number, wordsPerPage: number) => {
    const text = Array.from({ length: pages * wordsPerPage }, () => '(aaaaa) Tj').join('\n');
    return new TextEncoder().encode(
      `%PDF-1.4\n1 0 obj<</Type /Pages /Count ${pages}>>endobj\n` +
        Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj<</Type /Page /Parent 1 0 R>>endobj`).join('\n') +
        `\n${pages + 2} 0 obj<</Length 1>>stream\n${text}\nendstream endobj\n`,
    );
  };

  it('counts words from the content streams', () => {
    // 10 pages x 60 words x 5 chars = 3000 chars / 5.5
    expect(pdfWords(pdf(10, 60))).toBe(Math.round((10 * 60 * 5) / 5.5));
  });

  it('reads a sparse deck as reading time, not as pages x 4', () => {
    const deck = pdf(50, 60); // 60 words/page — a slide deck
    const words = pdfWords(deck) ?? 0;
    expect(words / 50).toBeLessThan(SLIDE_MAX_WORDS_PER_PAGE);
    expect(estimateOcwPdf(deck)).toEqual({ durationMin: readingMinutes(words), durationSource: 'extracted' });
    // The bug this rule exists to stop: 50 pages x 4 = 200 minutes for a deck that
    // holds well under an hour of reading.
    expect(estimateOcwPdf(deck).durationMin).toBeLessThan(50 * OCW_PDF_MIN_PER_PAGE);
  });

  it('keeps pages x 4 for dense notes', () => {
    const notes = pdf(10, 400); // 400 words/page — a textbook chapter
    expect(estimateOcwPdf(notes)).toEqual({
      durationMin: 10 * OCW_PDF_MIN_PER_PAGE,
      durationSource: 'extracted',
    });
  });

  it('falls back to pages x 4 when no text can be read at all', () => {
    // A scanned PDF: real pages, no content streams to count.
    const scanned = new TextEncoder().encode(
      `%PDF-1.4\n1 0 obj<</Type /Pages /Count 3>>endobj\n` +
        Array.from({ length: 3 }, (_, i) => `${i + 2} 0 obj<</Type /Page>>endobj`).join('\n'),
    );
    expect(pdfWords(scanned)).toBeNull();
    expect(estimateOcwPdf(scanned)).toEqual({ durationMin: 3 * OCW_PDF_MIN_PER_PAGE, durationSource: 'extracted' });
  });

  it('is unknown when a deck holds too little text to have been read', () => {
    expect(estimateOcwPdf(pdf(2, 20))).toEqual({ durationMin: null, durationSource: 'unknown' });
  });
});

describe('estimateOcwPage', () => {
  it('refuses to read navigation chrome as content — an OCW shell page is ~270 words', () => {
    expect(estimateOcwPage(page(`<p>${words(270)}</p>`))).toEqual({ durationMin: null, durationSource: 'unknown' });
  });

  it('reads a page that really does carry prose', () => {
    expect(estimateOcwPage(page(`<p>${words(1200)}</p>`))).toEqual({ durationMin: 10, durationSource: 'extracted' });
  });
});

describe('isoDurationToSeconds', () => {
  it.each([
    ['PT12M26S', 746],
    ['PT1H2M30S', 3750],
    ['PT15M', 900],
    ['PT45S', 45],
    ['P1DT2H', 93600],
  ])('parses %s', (iso, seconds) => {
    expect(isoDurationToSeconds(iso)).toBe(seconds);
  });

  it.each(['', 'PT', 'P', '12:26', 'garbage', 'PTM'])('returns null for %s rather than a fake 1', (iso) => {
    expect(isoDurationToSeconds(iso)).toBeNull();
  });
});

describe('secondsToMinutes', () => {
  it('rounds to whole minutes', () => {
    expect(secondsToMinutes(746)).toBe(12);
  });

  it('floors at one minute — a 40-second short is not zero time', () => {
    expect(secondsToMinutes(40)).toBe(1);
  });
});

// Q6b reuses Q2's container rule rather than re-deriving one; these pin the
// behaviour the container pass depends on.
describe('container reconciliation', () => {
  it('sums the children whose durations are known', () => {
    expect(containerDuration([{ durationMin: 12 }, { durationMin: 8 }, { durationMin: null }])).toEqual({
      durationMin: 20,
      durationSource: 'estimated',
    });
  });

  it('is unknown when every child is unknown', () => {
    expect(containerDuration([{ durationMin: null }, { durationMin: null }])).toEqual({
      durationMin: null,
      durationSource: 'unknown',
    });
  });

  it('repairs the arithmetic contradiction shape: 5m parent over 555m of children', () => {
    const children = Array.from({ length: 37 }, () => ({ durationMin: 15 }));
    expect(containerDuration(children).durationMin).toBe(555);
  });
});

// Q10 — attribution by re-derivation. The failure mode being guarded is a row
// gaining a provenance the evidence does not support, so every branch that is not
// an exact independent match must return null and leave the row `unknown`.
describe('attributeByRederivation', () => {
  it('attributes a number the source reproduces exactly', () => {
    expect(attributeByRederivation(12, 12)).toBe('api');
  });

  it('refuses a near miss — one minute off is a different measurement', () => {
    expect(attributeByRederivation(12, 13)).toBeNull();
  });

  it('cannot attribute when the source has nothing to say', () => {
    expect(attributeByRederivation(12, null)).toBeNull();
  });

  it('cannot attribute a row that carries no number', () => {
    expect(attributeByRederivation(null, 12)).toBeNull();
  });

  // The population B shape: a placeholder 20 next to a 6-minute video. It stays
  // unknown and gets counted, which is this pass succeeding, not failing.
  it('leaves the placeholder 20 unattributed against a real duration', () => {
    expect(attributeByRederivation(20, 6)).toBeNull();
  });
});
