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

import { webShortfall } from './web-fallback';

describe('webShortfall — rung-0 target arithmetic', () => {
  it('web discovery owes the full target when the library rung finds nothing', () => {
    expect(webShortfall(3, 0)).toBe(3);
  });

  it('library hits count toward the target', () => {
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
