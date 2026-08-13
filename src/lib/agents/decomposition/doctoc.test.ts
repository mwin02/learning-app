// Library-quality Q2 — the doc-TOC extraction contract for durations. The router
// never fetches a child page, so everything it can honestly say about a section's
// duration comes from the link text or the parent TOC; the prompt has to say that,
// and the schema has to allow "nothing".

import { describe, it, expect, vi } from 'vitest';

// doctoc.ts pulls in ./concepts → @/lib/db and @/lib/ai/models, both of which
// validate env at module-eval. Stub the leaves (see .claude/rules/testing.md).
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

import { EXTRACT_SYSTEM_PROMPT, ExtractionSchema } from './doctoc';

describe('ExtractionSchema durations', () => {
  const parse = (section: Record<string, unknown>) =>
    ExtractionSchema.parse({ pageKind: 'lesson_sequence', sections: [section] }).sections[0];

  it('leaves durationMin absent when the model omits it (no 20 default)', () => {
    const section = parse({ url: 'https://x.test/1', title: 'Lecture 1' });
    expect(section.durationMin).toBeUndefined();
    expect(section.durationStated).toBe(false);
  });

  it('keeps a stated duration and its stated flag', () => {
    const section = parse({
      url: 'https://x.test/1',
      title: 'Lecture 1',
      durationMin: 50,
      durationStated: true,
    });
    expect(section).toMatchObject({ durationMin: 50, durationStated: true });
  });
});

describe('EXTRACT_SYSTEM_PROMPT duration guidance', () => {
  it('tells the model it may return nothing', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/OMIT durationMin/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/"Unknown" is a correct, expected answer/);
  });

  it('points at the link text and TOC, not "the page" (which it never sees)', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/link text/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/table of contents/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/You have NOT seen the section's own page/);
  });

  it('carries per-type ranges so an estimate is at least calibrated', () => {
    for (const type of ['article', 'docs', 'video', 'interactive', 'course', 'book']) {
      expect(EXTRACT_SYSTEM_PROMPT).toContain(type);
    }
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/\d+-\d+/);
  });
});
