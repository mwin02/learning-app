// F2: unit tests for toCanonicalSlug — the safety net that coerces an LLM-minted
// canonical into a frozen-forever-safe kebab-case slug.
//
// topic-registry imports @/lib/db (prisma), which validates DATABASE_URL at
// module-eval and throws in the secret-free unit env — so stub the leaf. The slugifier
// under test is pure and never touches it. (See the module-eval gotcha in CLAUDE.md.)
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { toCanonicalSlug } from './topic-registry';

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
