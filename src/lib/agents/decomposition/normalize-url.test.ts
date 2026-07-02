// F8 unit tests for normalizeResourceUrl — the canonical URL used to dedup resources
// at ingest. Pure; no DB, no stubs needed.
import { describe, it, expect } from 'vitest';
import { normalizeResourceUrl } from './normalize-url';

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
});
