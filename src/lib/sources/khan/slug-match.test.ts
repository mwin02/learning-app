import { describe, it, expect } from 'vitest';
import { buildIndex, type KhanVideo } from './youtube-index';
import { proposeBySlug, slugKey } from './slug-match';

const video = (title: string, videoId = 'v1', durationSeconds = 746): KhanVideo => ({
  videoId,
  title,
  durationSeconds,
});

const khanUrl = (slug: string) =>
  `https://www.khanacademy.org/math/precalculus/x9e81a4f98389efdf:matrices/x9e81a4f98389efdf:intro/v/${slug}`;

describe('slugKey', () => {
  it('reduces the last path segment to the same key the index is built on', () => {
    expect(slugKey(khanUrl('introduction-to-matrices'))).toBe('introduction to matrices');
  });

  it('ignores a trailing slash', () => {
    expect(slugKey(`${khanUrl('limits-from-graphs')}/`)).toBe('limits from graphs');
  });

  it('is empty for a URL it cannot parse, so a malformed row is one unknown', () => {
    expect(slugKey('not a url')).toBe('');
  });
});

describe('proposeBySlug', () => {
  // The population this pass exists for: our row was retitled as an exercise
  // objective, so the title key finds nothing while the slug still names the video.
  it('proposes — never writes — when only the slug key resolves', () => {
    const index = buildIndex([video('Limits from graphs | Limits and continuity | Khan Academy', 'g1', 361)]);
    const result = proposeBySlug(index, {
      url: khanUrl('limits-from-graphs'),
      title: 'Estimate limit values from graphs',
    });
    expect(result).toEqual({ kind: 'confirm', video: expect.objectContaining({ videoId: 'g1' }), slugKey: 'limits from graphs' });
  });

  it('agrees when the title key resolves uniquely to the same video', () => {
    const index = buildIndex([video('One-time pad | Journey into cryptography', 'p1', 746)]);
    const result = proposeBySlug(index, { url: khanUrl('one-time-pad'), title: 'One-time pad' });
    expect(result).toMatchObject({ kind: 'agreed', video: { videoId: 'p1' } });
  });

  // An ambiguous title key is not agreement either: two re-uploads of one lesson
  // differ in length, so "one of these two" is still a coin flip.
  it('does not agree when the title key is ambiguous', () => {
    const index = buildIndex([
      video('Introduction to matrices', 'm1', 269),
      video('Introduction to matrices | Precalculus', 'm2', 711),
    ]);
    index.set('introduction to matrices', [
      ...(index.get('introduction to matrices') ?? []),
      video('Introduction to matrices (re-upload)', 'm3', 700),
    ]);
    expect(
      proposeBySlug(index, { url: khanUrl('introduction-to-matrices'), title: 'Introduction to matrices' }),
    ).toMatchObject({ kind: 'unresolved', reason: 'ambiguous' });
  });

  // Q6b's measured failure: two keys, two different videos, 711s vs 269s. The
  // title key naming a DIFFERENT video is not agreement — it is the disagreement
  // that made this a confirmation flow, so the slug's answer stays a proposal.
  it('does not agree when the title key names a different video', () => {
    const index = buildIndex([
      video('Introduction to matrices | Precalculus | Khan Academy', 'right', 269),
      video('Intro to matrices', 'wrong', 711),
    ]);
    const result = proposeBySlug(index, {
      url: khanUrl('introduction-to-matrices'),
      title: 'Intro to matrices',
    });
    expect(result).toMatchObject({ kind: 'confirm', video: { videoId: 'right' } });
  });

  it('is unresolved when the slug matches nothing', () => {
    const index = buildIndex([video('Limits from graphs')]);
    expect(proposeBySlug(index, { url: khanUrl('surface-integrals'), title: 'Surface integrals' })).toMatchObject({
      kind: 'unresolved',
      reason: 'no-match',
    });
  });

  it('is unresolved when the slug is itself ambiguous', () => {
    const index = buildIndex([video('Limits from graphs', 'a', 100), video('Limits from graphs', 'b', 200)]);
    expect(proposeBySlug(index, { url: khanUrl('limits-from-graphs'), title: 'Anything' })).toMatchObject({
      kind: 'unresolved',
      reason: 'ambiguous',
    });
  });

  it('is unresolved when the URL carries no slug at all', () => {
    expect(proposeBySlug(buildIndex([video('Limits from graphs')]), { url: '::::', title: 'Limits from graphs' })).toMatchObject({
      kind: 'unresolved',
      reason: 'no-slug',
    });
  });
});
