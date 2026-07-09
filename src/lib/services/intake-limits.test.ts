import { describe, expect, it, vi } from 'vitest';

// intake-limits imports @/lib/db (throws at module eval without DATABASE_URL);
// the parts under test here are pure.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  INTAKE_MAX_TURNS,
  intakeTurnBudget,
  parsePositiveIntEnv,
} from '@/lib/services/intake-limits';

describe('parsePositiveIntEnv', () => {
  it('parses a plain positive integer, tolerating whitespace', () => {
    expect(parsePositiveIntEnv('7', 5)).toBe(7);
    expect(parsePositiveIntEnv(' 12 ', 5)).toBe(12);
  });

  it('falls back when unset', () => {
    expect(parsePositiveIntEnv(undefined, 5)).toBe(5);
    expect(parsePositiveIntEnv('', 5)).toBe(5);
  });

  it('rejects values that would disable or corrupt a limit (0, negative, non-integer, junk)', () => {
    expect(parsePositiveIntEnv('0', 5)).toBe(5);
    expect(parsePositiveIntEnv('-3', 5)).toBe(5);
    expect(parsePositiveIntEnv('2.5', 5)).toBe(5);
    expect(parsePositiveIntEnv('unlimited', 5)).toBe(5);
  });
});

describe('intakeTurnBudget', () => {
  it('allows below the budget and reports usage', () => {
    const fresh = intakeTurnBudget({ turnCount: 0 });
    expect(fresh).toEqual({ allowed: true, used: 0, limit: INTAKE_MAX_TURNS });

    const last = intakeTurnBudget({ turnCount: INTAKE_MAX_TURNS - 1 });
    expect(last.allowed).toBe(true);
    expect(last.used).toBe(INTAKE_MAX_TURNS - 1);
  });

  it('blocks at and past the budget', () => {
    expect(intakeTurnBudget({ turnCount: INTAKE_MAX_TURNS }).allowed).toBe(false);
    expect(intakeTurnBudget({ turnCount: INTAKE_MAX_TURNS + 1 }).allowed).toBe(false);
  });
});
