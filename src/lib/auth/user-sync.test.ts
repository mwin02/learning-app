import { describe, expect, it, vi } from 'vitest';

// user-sync imports @/lib/db (throws at module eval without DATABASE_URL) —
// stub the leaf; profileFromAuthUser is pure.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { profileFromAuthUser } from '@/lib/auth/user-sync';
import { safeNextPath } from '@/app/auth/safe-next';

describe('profileFromAuthUser', () => {
  const base = { id: 'uuid-1', email: 'a@b.c' };

  it('maps a Google-shaped identity (full_name / avatar_url)', () => {
    expect(
      profileFromAuthUser({
        ...base,
        user_metadata: { full_name: 'Ada Lovelace', avatar_url: 'https://img/a.png' },
      })
    ).toEqual({ id: 'uuid-1', email: 'a@b.c', name: 'Ada Lovelace', avatarUrl: 'https://img/a.png' });
  });

  it('falls back to name / picture metadata keys', () => {
    expect(profileFromAuthUser({ ...base, user_metadata: { name: 'Ada', picture: 'p.png' } })).toEqual({
      id: 'uuid-1',
      email: 'a@b.c',
      name: 'Ada',
      avatarUrl: 'p.png',
    });
  });

  it('nulls missing/empty/non-string metadata', () => {
    expect(profileFromAuthUser({ ...base, user_metadata: { full_name: '', picture: 42 } })).toEqual({
      id: 'uuid-1',
      email: 'a@b.c',
      name: null,
      avatarUrl: null,
    });
    expect(profileFromAuthUser({ ...base, user_metadata: {} })?.name).toBeNull();
  });

  it('returns null without an email (User.email is NOT NULL)', () => {
    expect(profileFromAuthUser({ id: 'uuid-1', email: undefined, user_metadata: {} })).toBeNull();
  });
});

describe('safeNextPath', () => {
  it('passes same-origin relative paths', () => {
    expect(safeNextPath('/programs/abc')).toBe('/programs/abc');
    expect(safeNextPath('/learn/t1?x=1')).toBe('/learn/t1?x=1');
  });

  it('falls back to / for absolute, protocol-relative, or missing targets', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('/\\evil.com')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
  });
});
