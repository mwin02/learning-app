import { describe, expect, it, vi } from 'vitest';

// program-limits imports @/lib/db (throws at module eval without DATABASE_URL);
// monthStartUtc is pure.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { monthStartUtc } from '@/lib/services/program-limits';

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
