// Unit tests for the rung0-starvation R1 web-budget policy: how much the web rungs
// owe once rung 0's candidates have been judged and attached. source-concept's
// module graph pulls in env-validating leaves (@/lib/db, @/lib/ai/vertex,
// @/lib/ai/models) via the sourcing/judge chain, so those are stubbed per the
// CLAUDE.md module-eval note — the function under test is pure.
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

import { webBudgetAfterLibrary } from './source-concept';

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
