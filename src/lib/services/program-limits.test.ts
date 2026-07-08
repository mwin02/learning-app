import { describe, expect, it, vi } from 'vitest';

// program-limits imports @/lib/db (throws at module eval without DATABASE_URL);
// monthStartUtc is pure.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { monthStartUtc, programInputHash } from '@/lib/services/program-limits';

describe('monthStartUtc', () => {
  it('returns the first instant of the same UTC month', () => {
    expect(monthStartUtc(new Date('2026-07-04T15:30:00Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z'
    );
  });

  it('is UTC-anchored: a local-tz date late on the UTC 1st stays in that month', () => {
    // 00:30 UTC on the 1st (which is still the previous month in UTC-negative zones).
    expect(monthStartUtc(new Date('2026-03-01T00:30:00Z')).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z'
    );
  });

  it('handles January → January (no year underflow)', () => {
    expect(monthStartUtc(new Date('2026-01-15T12:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });
});

describe('programInputHash', () => {
  const base = {
    goal: 'Learn linear algebra for ML',
    background: 'Full-stack TS, rusty math',
    totalHoursPerWeek: 6,
    totalWeeks: 12,
    antiList: ['statistics', 'calculus'],
  };

  it('is deterministic', () => {
    expect(programInputHash(base)).toBe(programInputHash({ ...base }));
  });

  it('folds case and whitespace (a resubmit differing only in spacing/caps is the same intent)', () => {
    expect(
      programInputHash({ ...base, goal: '  learn   LINEAR algebra\nfor ml ' })
    ).toBe(programInputHash(base));
  });

  it('is antiList order-insensitive', () => {
    expect(programInputHash({ ...base, antiList: ['calculus', 'statistics'] })).toBe(
      programInputHash(base)
    );
  });

  it('treats a missing background/antiList the same as their empty forms', () => {
    const minimal = { goal: 'g', totalHoursPerWeek: 1, totalWeeks: 1 };
    expect(programInputHash({ ...minimal, background: '', antiList: [] })).toBe(
      programInputHash(minimal)
    );
  });

  it('changes when any substantive field changes', () => {
    const h = programInputHash(base);
    expect(programInputHash({ ...base, goal: 'Learn calculus' })).not.toBe(h);
    expect(programInputHash({ ...base, background: 'none' })).not.toBe(h);
    expect(programInputHash({ ...base, totalHoursPerWeek: 7 })).not.toBe(h);
    expect(programInputHash({ ...base, totalWeeks: 13 })).not.toBe(h);
    expect(programInputHash({ ...base, antiList: ['statistics'] })).not.toBe(h);
  });

  it('does not collide field boundaries (goal vs background carry-over)', () => {
    expect(
      programInputHash({ ...base, goal: 'Learn linear algebra', background: 'for ML now' })
    ).not.toBe(programInputHash({ ...base, goal: 'Learn linear algebra for ML', background: 'now' }));
  });
});
