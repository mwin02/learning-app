import { describe, it, expect } from 'vitest';
import { proposeKhanDuration, type KhanProbe } from './khan-probe-duration';
import { MATH_PROSE_WPM, MIN_CONTENT_WORDS, WORKED_EXAMPLE_MIN } from './duration-estimate';

const ARTICLE_URL = 'https://www.khanacademy.org/math/precalculus/x1:matrices/a/intro-to-matrices';
const VIDEO_URL = 'https://www.khanacademy.org/math/linear-algebra/vectors/v/intro-unit-vector-notation';

const probe = (over: Partial<KhanProbe> = {}): KhanProbe => ({
  url: ARTICLE_URL,
  pageKind: 'article',
  videoIds: [],
  articleWords: 1200,
  articleWordsBeforeExpand: 1200,
  collapsedExpanded: 0,
  workedExamples: 0,
  hasEditor: false,
  blocked: false,
  ...over,
});

// The two ids measured by hand against production pages on 2026-08-16.
const seconds = new Map([
  ['MMv-027KEqU', 223],
  ['CrV1xCWdY-g', 946],
]);

describe('videos', () => {
  it('resolves the single embedded id to an exact api duration', () => {
    const out = proposeKhanDuration('video', VIDEO_URL, probe({ url: VIDEO_URL, pageKind: 'video', videoIds: ['CrV1xCWdY-g'] }), seconds);
    expect(out).toMatchObject({ durationMin: 16, durationSource: 'api' });
    expect(out.evidence).toContain('946s');
  });

  it('rounds to whole minutes with a floor of 1', () => {
    expect(proposeKhanDuration('video', VIDEO_URL, probe({ url: VIDEO_URL, videoIds: ['MMv-027KEqU'], pageKind: 'video' }), seconds).durationMin).toBe(4);
    expect(
      proposeKhanDuration('video', VIDEO_URL, probe({ url: VIDEO_URL, videoIds: ['tiny'], pageKind: 'video' }), new Map([['tiny', 20]])).durationMin,
    ).toBe(1);
  });

  // Picking the first of several would be a guess carrying an `api` stamp — the exact
  // species of manufactured confidence this backfill exists to remove.
  it('refuses a page carrying more than one video id', () => {
    const out = proposeKhanDuration('video', VIDEO_URL, probe({ url: VIDEO_URL, pageKind: 'video', videoIds: ['CrV1xCWdY-g', 'MMv-027KEqU'] }), seconds);
    expect(out.durationSource).toBe('unknown');
    expect(out.evidence).toContain('need exactly 1');
  });

  it('stays unknown when the id resolves nowhere, rather than falling back to prose', () => {
    const out = proposeKhanDuration('video', VIDEO_URL, probe({ url: VIDEO_URL, pageKind: 'video', videoIds: ['nope'], articleWords: 5000 }), seconds);
    expect(out).toMatchObject({ durationMin: null, durationSource: 'unknown' });
  });

  // The stored type is not authoritative: a row typed `interactive` was found serving a
  // Khan `(video)` page. The page's own claim wins so a video is never word-counted.
  it('treats a page that says it is a video as one whatever the stored type says', () => {
    const out = proposeKhanDuration('interactive', VIDEO_URL, probe({ url: VIDEO_URL, pageKind: 'video', videoIds: ['MMv-027KEqU'] }), seconds);
    expect(out.durationSource).toBe('api');
  });
});

describe('articles', () => {
  it('applies the math-prose rate to the expanded article body', () => {
    const out = proposeKhanDuration('article', ARTICLE_URL, probe({ articleWords: 1409, articleWordsBeforeExpand: 1356, collapsedExpanded: 1 }), seconds);
    expect(out).toMatchObject({ durationMin: Math.round(1409 / MATH_PROSE_WPM), durationSource: 'extracted' });
  });

  it('charges each worked example on top of the word count', () => {
    const plain = proposeKhanDuration('article', ARTICLE_URL, probe({ articleWords: 1200, workedExamples: 0 }), seconds);
    const withExamples = proposeKhanDuration('article', ARTICLE_URL, probe({ articleWords: 1200, workedExamples: 3 }), seconds);
    expect((withExamples.durationMin ?? 0) - (plain.durationMin ?? 0)).toBe(3 * WORKED_EXAMPLE_MIN);
  });

  it('reports the reveal delta as evidence so a missed expansion is visible in the diff', () => {
    const out = proposeKhanDuration('article', ARTICLE_URL, probe({ articleWords: 2393, articleWordsBeforeExpand: 719, collapsedExpanded: 4 }), seconds);
    expect(out.evidence).toContain('+1674 from 4 reveal(s)');
  });

  it('is unknown under the content floor, never a small number', () => {
    const out = proposeKhanDuration('article', ARTICLE_URL, probe({ articleWords: MIN_CONTENT_WORDS - 1 }), seconds);
    expect(out).toMatchObject({ durationMin: null, durationSource: 'unknown' });
    expect(out.evidence).toContain('content floor');
  });
});

// Khan articles embed videos, and both ends of the range are real: 4-second animations
// that barely register, and a 14-minute lecture inside a 663-word page.
describe('articles that embed videos', () => {
  it('adds the embedded runtime to the reading time', () => {
    const out = proposeKhanDuration(
      'article',
      ARTICLE_URL,
      probe({ articleWords: 663, videoIds: ['CrV1xCWdY-g'] }),
      new Map([['CrV1xCWdY-g', 840]]),
    );
    // 663 words → 6 min read, plus a 14-minute lecture. Reading time alone would say 6.
    expect(out).toMatchObject({ durationMin: 6 + 14, durationSource: 'extracted' });
    expect(out.evidence).toContain('embedded video');
  });

  it('barely moves for a page full of few-second animations', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `anim${i}`);
    const out = proposeKhanDuration(
      'article',
      ARTICLE_URL,
      probe({ articleWords: 1489, videoIds: ids }),
      new Map(ids.map((id) => [id, 8])),
    );
    // 88 seconds of animation across 11 clips → 1 minute on top of a 12-minute read.
    expect(out.durationMin).toBe(12 + 1);
  });

  // The composite carries two provenances and the column holds one, so it takes the
  // weaker rather than borrowing the Data API's authority for the prose half.
  it('stamps the composite extracted, never api', () => {
    const out = proposeKhanDuration('article', ARTICLE_URL, probe({ videoIds: ['CrV1xCWdY-g'] }), seconds);
    expect(out.durationSource).toBe('extracted');
  });

  it('is unknown when any embedded clip is unresolved, rather than summing a partial', () => {
    const out = proposeKhanDuration(
      'article',
      ARTICLE_URL,
      probe({ articleWords: 1489, videoIds: ['CrV1xCWdY-g', 'missing'] }),
      seconds,
    );
    expect(out).toMatchObject({ durationMin: null, durationSource: 'unknown' });
    expect(out.evidence).toContain('under-count');
  });
});

// Khan redirects freely. A slug change is routine; a CONTENT-KIND change means the row
// now points at something else entirely. Measured on batch 02: 5 of 25 stored `/a/` URLs.
describe('redirects across content kinds', () => {
  it('refuses an article row whose URL now serves a video', () => {
    const out = proposeKhanDuration(
      'article',
      ARTICLE_URL,
      probe({ url: VIDEO_URL, pageKind: 'video', videoIds: ['CrV1xCWdY-g'] }),
      seconds,
    );
    expect(out).toMatchObject({ durationMin: null, durationSource: 'unknown' });
    expect(out.evidence).toContain('needs review');
  });

  it('refuses an article row that lands on a bare unit page', () => {
    const out = proposeKhanDuration(
      'article',
      ARTICLE_URL,
      probe({ url: 'https://www.khanacademy.org/math/multivariable-calculus/multivariable-derivatives', pageKind: 'other', articleWords: null }),
      seconds,
    );
    expect(out.evidence).toContain('needs review');
  });

  it('accepts a slug change that stays the same kind', () => {
    const out = proposeKhanDuration(
      'article',
      'https://www.khanacademy.org/math/mv-calc/x/a/partial-derivatives',
      probe({ url: 'https://www.khanacademy.org/math/mv-calc/x/a/partial-derivative-and-gradient-articles', articleWords: 1772 }),
      seconds,
    );
    expect(out.durationSource).toBe('extracted');
  });
});

describe('unreadable pages', () => {
  it('is unknown when the agent reported a failure', () => {
    expect(proposeKhanDuration('article', ARTICLE_URL, null, seconds).durationSource).toBe('unknown');
  });

  it('is unknown for a bot wall or a 404, never counted as a short page', () => {
    const out = proposeKhanDuration('article', ARTICLE_URL, probe({ blocked: true, articleWords: 5000 }), seconds);
    expect(out).toMatchObject({ durationMin: null, durationSource: 'unknown' });
  });

  // `/pt/` interactives are scratchpad coding challenges. There is no prose to read and
  // no exercise to count, so they stay unknown instead of taking an invented constant.
  it('is unknown for a coding challenge with no article body', () => {
    const out = proposeKhanDuration('interactive', ARTICLE_URL, probe({ pageKind: 'challenge', articleWords: null, hasEditor: true }), seconds);
    expect(out.evidence).toContain('coding challenge');
  });

  it('never returns the reviewer tier', () => {
    const all = [
      proposeKhanDuration('video', VIDEO_URL, probe({ url: VIDEO_URL, pageKind: 'video', videoIds: ['MMv-027KEqU'] }), seconds),
      proposeKhanDuration('article', ARTICLE_URL, probe(), seconds),
      proposeKhanDuration('interactive', ARTICLE_URL, probe({ articleWords: null }), seconds),
      proposeKhanDuration('article', ARTICLE_URL, null, seconds),
    ];
    expect(all.map((p) => p.durationSource).sort()).toEqual(['api', 'extracted', 'unknown', 'unknown']);
  });
});
