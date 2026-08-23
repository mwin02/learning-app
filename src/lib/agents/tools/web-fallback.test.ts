// Unit tests for the rung-0 shortfall arithmetic (Block 4). web-fallback's
// module graph pulls in env-validating leaves (@/lib/db, @/lib/ai/vertex,
// @/lib/ai/models), so those are stubbed per the CLAUDE.md module-eval note —
// the function under test is pure.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  geminiFlash: {},
  vertexAnthropic: {},
  vertexGlobal: {},
}));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

import { webShortfall, joinDescribedRows } from './web-fallback';

describe('webShortfall — rung-0 target arithmetic', () => {
  it('web discovery owes the full target when the library rung attaches nothing', () => {
    expect(webShortfall(3, 0)).toBe(3);
  });

  it('library ATTACHMENTS count toward the target (R1: survivors, not raw hits)', () => {
    expect(webShortfall(3, 1)).toBe(2);
    expect(webShortfall(3, 2)).toBe(1);
  });

  it('a filled target skips web discovery entirely', () => {
    expect(webShortfall(3, 3)).toBe(0);
  });

  it('floors at zero when the library over-fills (never negative discovery)', () => {
    expect(webShortfall(3, 5)).toBe(0);
  });
});

// The URL in a discovered row comes from the attested candidate list, never from
// the model — see the runDiscovery header. These cases are the seam that keeps
// that true.
describe('joinDescribedRows — describe-call rows joined onto attested URLs', () => {
  const candidates = [
    { url: 'https://ocw.mit.edu/courses/6-004/pages/c7' },
    { url: 'https://docs.python.org/3/tutorial/classes.html' },
  ];

  const described = (over: Record<string, unknown> = {}) => ({
    index: 0,
    title: 'Virtual Memory',
    type: 'article' as const,
    difficulty: 'intermediate' as const,
    durationStated: false,
    summary: 'Explains paging and address translation.',
    rawPrerequisiteConcepts: [],
    rawConceptsTaught: ['virtual-memory'],
    ...over,
  });

  it('takes the url from the candidate at that index', () => {
    const out = joinDescribedRows(candidates, [described({ index: 1 })]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://docs.python.org/3/tutorial/classes.html');
  });

  it('ignores any url the model smuggled into its row', () => {
    const out = joinDescribedRows(candidates, [
      described({ url: 'https://ocw.mit.edu/courses/6-828/resources/lecture-10-file-systems' } as never),
    ]);
    expect(out[0].url).toBe(candidates[0].url);
  });

  it('drops an index that names no candidate', () => {
    expect(joinDescribedRows(candidates, [described({ index: 7 })])).toEqual([]);
  });

  it('keeps only the first row for a repeated index', () => {
    const out = joinDescribedRows(candidates, [
      described({ index: 0, title: 'First' }),
      described({ index: 0, title: 'Second' }),
    ]);
    expect(out.map((r) => r.title)).toEqual(['First']);
  });

  it('drops a row that fails the resource schema', () => {
    expect(joinDescribedRows(candidates, [described({ rawConceptsTaught: [] })])).toEqual([]);
  });

  it('describing fewer candidates than were attested is not an error', () => {
    expect(joinDescribedRows(candidates, [])).toEqual([]);
  });
});
