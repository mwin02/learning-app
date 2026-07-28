// F2: unit tests for toCanonicalSlug — the safety net that coerces an LLM-minted
// canonical into a frozen-forever-safe kebab-case slug.
//
// topic-registry imports @/lib/db (prisma), which validates DATABASE_URL at
// module-eval and throws in the secret-free unit env — so stub the leaf. The slugifier
// under test is pure and never touches it. (See the module-eval gotcha in CLAUDE.md.)
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { toCanonicalSlug, snapToKnownSlug } from './topic-registry';
import { TOPIC_SLUGS } from '@/types/resource';

describe('toCanonicalSlug', () => {
  it('lowercases and hyphenates whitespace', () => {
    expect(toCanonicalSlug('Machine Learning')).toBe('machine-learning');
  });

  it('leaves an already-clean slug untouched', () => {
    expect(toCanonicalSlug('linear-algebra')).toBe('linear-algebra');
  });

  it('collapses runs of separators/punctuation to a single hyphen', () => {
    expect(toCanonicalSlug('React.js  &  Redux')).toBe('react-js-redux');
    expect(toCanonicalSlug('data___science')).toBe('data-science');
    expect(toCanonicalSlug('go--lang')).toBe('go-lang');
  });

  it('trims leading and trailing junk', () => {
    expect(toCanonicalSlug('  ...Python!!!  ')).toBe('python');
    expect(toCanonicalSlug('-go-')).toBe('go');
  });

  it('ASCII-folds accents', () => {
    expect(toCanonicalSlug('Café Calculus')).toBe('cafe-calculus');
    expect(toCanonicalSlug('Schrödinger')).toBe('schrodinger');
  });

  it('returns empty string when nothing usable survives', () => {
    expect(toCanonicalSlug('')).toBe('');
    expect(toCanonicalSlug('   ')).toBe('');
    expect(toCanonicalSlug('!!!')).toBe('');
    expect(toCanonicalSlug('___')).toBe('');
    expect(toCanonicalSlug('你好')).toBe(''); // non-ASCII with no ASCII fold → nothing survives
  });

  it('caps length at 64 chars and re-trims a trailing hyphen after the cut', () => {
    const long = 'a'.repeat(70);
    expect(toCanonicalSlug(long)).toBe('a'.repeat(64));

    // A cut landing on a separator must not leave a trailing hyphen.
    const cutOnHyphen = `${'a'.repeat(63)} bcd`; // char 64 is the space→hyphen
    const out = toCanonicalSlug(cutOnHyphen);
    expect(out).toBe('a'.repeat(63));
    expect(out.endsWith('-')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(64);
  });
});

// T1.5: the anti-drift guard. Both real twins this replays actually happened —
// `data-structures-and-algorithms` next to the curated `data-structures-algorithms`,
// and `probability` next to `probability-and-statistics`.
describe('snapToKnownSlug', () => {
  // A realistic vocabulary: curated TOPIC_SLUGS ∪ the canonicals the gate has learned.
  const KNOWN = [
    ...TOPIC_SLUGS,
    'probability-and-statistics',
    'calculus-for-machine-learning',
    'discrete-mathematics',
    'multivariable-calculus',
  ];

  it('snaps a filler-word twin onto the curated slug', () => {
    // The motivating case. Note a de-hyphenated comparison would MISS this:
    // "datastructuresandalgorithms" !== "datastructuresalgorithms".
    expect(snapToKnownSlug('data-structures-and-algorithms', KNOWN)).toBe('data-structures-algorithms');
  });

  it('snaps a reordered twin', () => {
    expect(snapToKnownSlug('algorithms-and-data-structures', KNOWN)).toBe('data-structures-algorithms');
  });

  it('snaps onto a learned canonical, not just a curated one', () => {
    // The `probability` twin was a twin of a LEARNED slug — a curated-only guard
    // would not have caught this class at all.
    expect(snapToKnownSlug('probability-statistics', KNOWN)).toBe('probability-and-statistics');
  });

  it('leaves an exact known slug alone', () => {
    expect(snapToKnownSlug('linear-algebra', KNOWN)).toBe('linear-algebra');
    expect(snapToKnownSlug('probability-and-statistics', KNOWN)).toBe('probability-and-statistics');
  });

  it('leaves a genuinely new topic alone', () => {
    expect(snapToKnownSlug('organic-chemistry', KNOWN)).toBe('organic-chemistry');
    expect(snapToKnownSlug('distributed-systems', KNOWN)).toBe('distributed-systems');
  });

  // The property that makes the guard safe to run unattended: an extra CONTENT token
  // blocks the snap, so deliberately-scoped mints survive.
  it('refuses to snap a scoped variant onto its base topic', () => {
    expect(snapToKnownSlug('calculus-for-machine-learning', KNOWN)).toBe('calculus-for-machine-learning');
    expect(snapToKnownSlug('linear-algebra-for-deep-learning', KNOWN)).toBe('linear-algebra-for-deep-learning');
    expect(snapToKnownSlug('multivariable-calculus', KNOWN)).toBe('multivariable-calculus');
  });

  it('refuses to merge distinct topics that merely share a token', () => {
    expect(snapToKnownSlug('probability', KNOWN)).toBe('probability');
    expect(snapToKnownSlug('applied-statistics', KNOWN)).toBe('applied-statistics');
    // Distance-based matching would be tempted by these; token sets are not.
    expect(snapToKnownSlug('pytorch', KNOWN)).toBe('pytorch');
    expect(snapToKnownSlug('calculus-2', KNOWN)).toBe('calculus-2');
  });

  it('prefers a curated slug when both a curated and a learned slug match', () => {
    const known = ['data-structures-algorithms', 'data-structures-and-algorithms'];
    expect(snapToKnownSlug('algorithms-data-structures', known)).toBe('data-structures-algorithms');
  });

  it('never snaps an all-stopword or empty slug', () => {
    expect(snapToKnownSlug('the-and', ['for-the', 'python'])).toBe('the-and');
    expect(snapToKnownSlug('', KNOWN)).toBe('');
  });

  it('is a no-op against an empty vocabulary', () => {
    expect(snapToKnownSlug('data-structures-and-algorithms', [])).toBe('data-structures-and-algorithms');
  });
});
