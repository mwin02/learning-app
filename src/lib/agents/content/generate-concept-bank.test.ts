import { describe, it, expect, vi } from 'vitest';

// generate-concept-bank imports @/lib/db and (via author-concept-bank) the model
// registry — both validate env at module-eval. Stub the leaves; the predicate
// under test is pure (see CLAUDE.md's module-eval gotcha).
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

import { isBankAttemptCooling } from '@/lib/agents/content/generate-concept-bank';
import { CONCEPT_BANK_ATTEMPT_COOLDOWN_MS } from '@/lib/config';

const NOW = new Date('2026-07-17T12:00:00Z');

describe('isBankAttemptCooling', () => {
  it('is not cooling when never attempted (null stamp)', () => {
    expect(isBankAttemptCooling(null, NOW)).toBe(false);
  });

  it('is cooling for an attempt inside the cool-down', () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000);
    expect(isBankAttemptCooling(recent, NOW)).toBe(true);
  });

  it('is cooling just inside the boundary', () => {
    const fresh = new Date(NOW.getTime() - CONCEPT_BANK_ATTEMPT_COOLDOWN_MS + 1);
    expect(isBankAttemptCooling(fresh, NOW)).toBe(true);
  });

  it('stops cooling exactly at the cool-down age', () => {
    const aged = new Date(NOW.getTime() - CONCEPT_BANK_ATTEMPT_COOLDOWN_MS);
    expect(isBankAttemptCooling(aged, NOW)).toBe(false);
  });
});
