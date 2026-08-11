import { describe, it, expect } from 'vitest';
import { buildIndex, lookupTitle, normaliseTitle, type KhanVideo } from './youtube-index';

const video = (title: string, videoId = 'v1', durationSeconds = 746): KhanVideo => ({
  videoId,
  title,
  durationSeconds,
});

describe('normaliseTitle', () => {
  it('keeps only the segment before the first breadcrumb separator', () => {
    expect(normaliseTitle('One-time pad | Journey into cryptography | Computer Science | Khan Academy')).toBe(
      'one time pad',
    );
  });

  it('normalises our own breadcrumbed titles the same way', () => {
    expect(normaliseTitle('The quadratic formula | Algebra (video)')).toBe(normaliseTitle('The quadratic formula'));
  });

  it('folds case, diacritics and punctuation', () => {
    expect(normaliseTitle("L'Hôpital's rule: composite exponential functions")).toBe(
      'l hopital s rule composite exponential functions',
    );
  });

  it('spells out & so both of Khan\'s conventions land on one key', () => {
    expect(normaliseTitle('Vectors & spaces')).toBe(normaliseTitle('Vectors and spaces'));
  });

  it('is empty for a title that is only a breadcrumb', () => {
    expect(normaliseTitle(' | Khan Academy')).toBe('');
  });
});

describe('lookupTitle', () => {
  it('resolves a known video to its exact duration', () => {
    const index = buildIndex([video('One-time pad | Journey into cryptography | Khan Academy', 'abc123', 746)]);
    const hit = lookupTitle(index, 'One-time pad');
    expect(hit).toEqual({ ok: true, video: { videoId: 'abc123', title: expect.any(String), durationSeconds: 746 } });
  });

  // The degradation contract. Every shape below must reach `unknown` at the caller,
  // and none of them may reach a number — least of all 20.
  it('reports no-match rather than guessing at the nearest title', () => {
    const index = buildIndex([video('Introduction to limits')]);
    expect(lookupTitle(index, 'Introduction to derivatives')).toEqual({
      ok: false,
      reason: 'no-match',
      candidates: 0,
    });
  });

  it('reports ambiguous when a normalised title collides — a re-upload differs in length', () => {
    const index = buildIndex([video('Introduction to limits', 'a', 300), video('Introduction to limits', 'b', 900)]);
    expect(lookupTitle(index, 'Introduction to limits')).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: 2,
    });
  });

  it('reports no-match against an empty index — a failed enumeration recovers nothing', () => {
    expect(lookupTitle(buildIndex([]), 'One-time pad')).toEqual({ ok: false, reason: 'no-match', candidates: 0 });
  });

  it('reports no-match for a title that normalises to nothing', () => {
    expect(lookupTitle(buildIndex([video('Anything')]), '| Khan Academy')).toEqual({
      ok: false,
      reason: 'no-match',
      candidates: 0,
    });
  });
});

describe('buildIndex', () => {
  it('drops entries whose title normalises to nothing rather than keying them on ""', () => {
    expect(buildIndex([video(' | Khan Academy'), video('Real lesson')]).size).toBe(1);
  });

  it('groups collisions instead of letting the last write win', () => {
    const index = buildIndex([video('Same title', 'a'), video('Same title', 'b')]);
    expect(index.get('same title')).toHaveLength(2);
  });
});
