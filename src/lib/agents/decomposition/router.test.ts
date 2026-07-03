// Unit tests for the decomposition classifier (pure, URL shape + type only).
// Block 0 (container containment) added `book` to CONTAINER_TYPES — an online
// book is a chaptered tree the doc-TOC router should decide on, not an atomic
// unit by default (the 1,200m MML book escape).
import { describe, it, expect } from 'vitest';
import { classify } from '@/lib/agents/decomposition/router';

describe('classify — container types route to doc_toc', () => {
  it.each(['course', 'interactive', 'docs', 'book'])('%s → doc_toc', (type) => {
    expect(classify({ url: 'https://example.com/x', type })).toEqual({ kind: 'doc_toc' });
  });
  it('non-container types stay atomic', () => {
    for (const type of ['video', 'article', 'exercise']) {
      expect(classify({ url: 'https://example.com/x', type })).toEqual({ kind: 'atomic' });
    }
  });
});

describe('classify — YouTube decided by URL, not type label', () => {
  it('single watch URL is atomic even when typed course/book', () => {
    for (const type of ['course', 'book']) {
      expect(classify({ url: 'https://www.youtube.com/watch?v=abc', type })).toEqual({ kind: 'atomic' });
    }
  });
  it('playlist URL routes to youtube_playlist', () => {
    expect(classify({ url: 'https://www.youtube.com/playlist?list=PL123', type: 'video' })).toEqual({
      kind: 'youtube_playlist',
      playlistId: 'PL123',
    });
  });
});

describe('classify — paywalled platforms', () => {
  it('paywalled host wins over container type', () => {
    expect(classify({ url: 'https://www.coursera.org/learn/ml', type: 'book' })).toEqual({
      kind: 'unsupported',
      platform: 'Coursera',
    });
  });
});
