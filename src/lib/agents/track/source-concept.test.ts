// Unit tests for the rung0-starvation R1 web-budget policy: how much the web rungs
// owe once rung 0's candidates have been judged and attached. source-concept's
// module graph pulls in env-validating leaves (@/lib/db, @/lib/ai/vertex,
// @/lib/ai/models) via the sourcing/judge chain, so those are stubbed per the
// CLAUDE.md module-eval note. The timeout-containment tests at the bottom also
// stub the judge and the sourcing rungs, and give the prisma stub the two reads
// that run before the judge.
import { describe, it, expect, vi, afterEach } from 'vitest';

const resourceFindMany = vi.fn();
const conceptResourceFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    resource: { findMany: (...a: unknown[]) => resourceFindMany(...a) },
    conceptResource: { findMany: (...a: unknown[]) => conceptResourceFindMany(...a) },
  },
}));
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  vertexAnthropic: {},
  vertexGlobal: {},
}));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

const judgeCandidates = vi.fn();
vi.mock('@/lib/agents/map/candidate-judge', () => ({
  judgeCandidates: (...a: unknown[]) => judgeCandidates(...a),
}));
const libraryRungCandidates = vi.fn();
const sourceFromWeb = vi.fn();
vi.mock('@/lib/agents/tools/web-fallback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/tools/web-fallback')>()),
  libraryRungCandidates: (...a: unknown[]) => libraryRungCandidates(...a),
  sourceFromWeb: (...a: unknown[]) => sourceFromWeb(...a),
}));

import { CallTimeoutError } from '@/lib/ai/call-middleware';
import { webBudgetAfterLibrary, rejectedCandidates, sourceAndAttachConcept } from './source-concept';

const TARGET = 3;

describe('webBudgetAfterLibrary — the R1 budget derivation', () => {
  it('a library rung that attached the whole target skips web discovery', () => {
    expect(
      webBudgetAfterLibrary({
        targetCount: TARGET,
        libraryAttached: 3,
        libraryPrimaryAttached: true,
        requirePrimary: true,
      }),
    ).toBe(0);
  });

  it('a library rung whose candidates were ALL judged away owes the full target', () => {
    // The defect this block fixes: pre-R1 three raw hits zeroed this budget even
    // when the judge kept none of them.
    expect(
      webBudgetAfterLibrary({
        targetCount: TARGET,
        libraryAttached: 0,
        libraryPrimaryAttached: false,
        requirePrimary: true,
      }),
    ).toBe(TARGET);
  });

  it('attachments that are not a qualifying primary still buy a web look for a hole', () => {
    // 3 rows attached as `uses`: the target is numerically full, but readiness
    // still calls the concept a hole — so the floor applies.
    const budget = webBudgetAfterLibrary({
      targetCount: TARGET,
      libraryAttached: 3,
      libraryPrimaryAttached: false,
      requirePrimary: true,
    });
    expect(budget).toBeGreaterThanOrEqual(1);
  });

  it('a partial fill without a primary takes the larger of the shortfall and the floor', () => {
    expect(
      webBudgetAfterLibrary({
        targetCount: TARGET,
        libraryAttached: 1,
        libraryPrimaryAttached: false,
        requirePrimary: true,
      }),
    ).toBe(2);
  });

  it('requirePrimary: false (the thickener) never floors — a full target means no web call', () => {
    expect(
      webBudgetAfterLibrary({
        targetCount: TARGET,
        libraryAttached: 3,
        libraryPrimaryAttached: false,
        requirePrimary: false,
      }),
    ).toBe(0);
  });

  it('an over-full library rung never demands negative discovery', () => {
    expect(
      webBudgetAfterLibrary({
        targetCount: TARGET,
        libraryAttached: 5,
        libraryPrimaryAttached: true,
        requirePrimary: true,
      }),
    ).toBe(0);
  });
});

describe('rejectedCandidates — what R2 writes to the rejection memory', () => {
  const judged = [
    { resourceId: 'a', coverageScore: 0.9 },
    { resourceId: 'b', coverageScore: 0.1 },
    { resourceId: 'c', coverageScore: 0.0 },
  ];

  it('remembers every judged candidate the attach filter dropped, with its score', () => {
    expect(rejectedCandidates(judged, [{ resourceId: 'a' }])).toEqual([
      { resourceId: 'b', coverageScore: 0.1 },
      { resourceId: 'c', coverageScore: 0.0 },
    ]);
  });

  it('remembers the WHOLE set when nothing was kept — the starvation case', () => {
    expect(rejectedCandidates(judged, []).map((r) => r.resourceId)).toEqual(['a', 'b', 'c']);
  });

  it('remembers nothing when every candidate attached', () => {
    expect(rejectedCandidates(judged, judged)).toEqual([]);
  });

  it('is empty for an empty judge pass', () => {
    expect(rejectedCandidates([], [])).toEqual([]);
  });
});

// A timed-out model call must cost one concept, not the thicken cycle or the
// remediation pass that called it. Anything else still propagates.
describe('sourceAndAttachConcept — call timeout containment', () => {
  const args = { pathId: 'p1', topic: 'databases', conceptId: 'c1', slug: 'sql-joins', title: 'SQL joins' };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  function timeoutWarnLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return spy.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((line: Record<string, unknown>) => line.event === 'source-concept.call-timeout');
  }

  // Rung 0 offers one library row, so the first model call is the judge's.
  function withLibraryCandidate() {
    libraryRungCandidates.mockResolvedValue([{ id: 'r1' }]);
    conceptResourceFindMany.mockResolvedValue([]);
    resourceFindMany.mockResolvedValue([{ id: 'r1', title: 'Joins explained' }]);
  }

  it('attaches nothing and warns once when the judge times out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withLibraryCandidate();
    judgeCandidates.mockRejectedValue(new CallTimeoutError('mapCandidateJudge', 90_000));

    await expect(sourceAndAttachConcept(args)).resolves.toBe(0);

    const lines = timeoutWarnLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      pathId: 'p1',
      concept: 'sql-joins',
      agent: 'mapCandidateJudge',
      timeoutMs: 90_000,
      attached: 0,
    });
    expect(sourceFromWeb).not.toHaveBeenCalled();
  });

  it('attaches nothing and warns once when the web rung times out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    libraryRungCandidates.mockResolvedValue([]);
    sourceFromWeb.mockRejectedValue(new CallTimeoutError('discoveryDescriber', 90_000));

    await expect(sourceAndAttachConcept(args)).resolves.toBe(0);
    expect(timeoutWarnLines(warn)).toHaveLength(1);
    expect(timeoutWarnLines(warn)[0].agent).toBe('discoveryDescriber');
  });

  it('still rejects on a job abort', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withLibraryCandidate();
    const controller = new AbortController();
    judgeCandidates.mockImplementation(async () => {
      controller.abort();
      throw new Error('request cancelled');
    });

    await expect(
      sourceAndAttachConcept({ ...args, abortSignal: controller.signal }),
    ).rejects.toThrow('request cancelled');
    expect(timeoutWarnLines(warn)).toHaveLength(0);
  });

  it('still rejects on any other error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withLibraryCandidate();
    judgeCandidates.mockRejectedValue(new Error('quota exhausted'));

    await expect(sourceAndAttachConcept(args)).rejects.toThrow('quota exhausted');
    expect(timeoutWarnLines(warn)).toHaveLength(0);
  });
});
