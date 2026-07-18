// F8 unit tests for normalizeResourceUrl — the canonical URL used to dedup resources
// at ingest — plus the anchor-children guard (manual one-page-book split). Pure; no
// DB, no stubs needed.
import { describe, it, expect } from 'vitest';
import { normalizeResourceUrl, validateAnchorChildren } from './normalize-url';

describe('normalizeResourceUrl', () => {
  it('leaves an already-clean URL untouched', () => {
    expect(normalizeResourceUrl('https://tutorial.math.lamar.edu/classes/calcii/series.aspx')).toBe(
      'https://tutorial.math.lamar.edu/classes/calcii/series.aspx',
    );
  });

  it('lowercases scheme and host but preserves path case', () => {
    expect(normalizeResourceUrl('HTTPS://Example.COM/Path/To/Page')).toBe('https://example.com/Path/To/Page');
  });

  it('strips the fragment', () => {
    expect(normalizeResourceUrl('https://example.com/a#section-3')).toBe('https://example.com/a');
  });

  it('strips a trailing slash on a non-root path but keeps root', () => {
    expect(normalizeResourceUrl('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(normalizeResourceUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('strips known tracking params while keeping meaningful ones', () => {
    expect(normalizeResourceUrl('https://example.com/x?utm_source=news&id=42&fbclid=abc')).toBe(
      'https://example.com/x?id=42',
    );
  });

  it('drops the default port', () => {
    expect(normalizeResourceUrl('https://example.com:443/x')).toBe('https://example.com/x');
  });

  it('collapses trivially-different variants of the same page onto one canonical', () => {
    const a = normalizeResourceUrl('https://Example.com/Calc/Series/?utm_campaign=spring#top');
    const b = normalizeResourceUrl('https://example.com/Calc/Series');
    expect(a).toBe(b);
  });

  it('returns a non-absolute / malformed URL unchanged (trimmed)', () => {
    expect(normalizeResourceUrl('  not a url  ')).toBe('not a url');
  });

  it('keeps the fragment under keepFragment', () => {
    expect(normalizeResourceUrl('https://example.com/book#chapter-3', { keepFragment: true })).toBe(
      'https://example.com/book#chapter-3',
    );
  });

  it('still strips tracking params and trailing slash under keepFragment', () => {
    expect(
      normalizeResourceUrl('https://example.com/book/?utm_source=x&id=42#ch-2', { keepFragment: true }),
    ).toBe('https://example.com/book?id=42#ch-2');
  });

  it('keepFragment: false matches the default (fragment stripped)', () => {
    expect(normalizeResourceUrl('https://example.com/a#s', { keepFragment: false })).toBe(
      normalizeResourceUrl('https://example.com/a#s'),
    );
  });

  it('keeps distinct anchors on one page as distinct canonical URLs', () => {
    const a = normalizeResourceUrl('https://example.com/book#ch-1', { keepFragment: true });
    const b = normalizeResourceUrl('https://example.com/book#ch-2', { keepFragment: true });
    expect(a).not.toBe(b);
  });
});

describe('validateAnchorChildren', () => {
  const parent = 'https://example.com/book';

  it('accepts same-page fragment children (and plain cross-page children)', () => {
    expect(
      validateAnchorChildren(parent, [
        'https://example.com/book#ch-1',
        'https://example.com/book#ch-2',
        'https://other.com/lesson', // no fragment — not an anchor child, always fine
      ]),
    ).toEqual({ crossPage: [], duplicates: [] });
  });

  it('rejects a fragment onto a different page', () => {
    expect(validateAnchorChildren(parent, ['https://other.com/page#ch-1'])).toEqual({
      crossPage: ['https://other.com/page#ch-1'],
      duplicates: [],
    });
  });

  it('flags two children with the same anchor', () => {
    expect(
      validateAnchorChildren(parent, ['https://example.com/book#ch-1', 'https://example.com/book#ch-1']),
    ).toEqual({ crossPage: [], duplicates: ['https://example.com/book#ch-1'] });
  });

  it('matches the parent page across trailing-slash / tracking-param / case variants', () => {
    expect(
      validateAnchorChildren('https://Example.com/book/', [
        'https://example.com/book?utm_source=x#ch-1',
      ]),
    ).toEqual({ crossPage: [], duplicates: [] });
  });
});
