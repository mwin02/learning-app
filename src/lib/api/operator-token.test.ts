import { describe, expect, it } from 'vitest';
import {
  MIN_TOKEN_BYTES,
  bearerToken,
  resolveOperatorPrincipal,
  tokenMatches,
} from './operator-token';

const VALID = 'a'.repeat(MIN_TOKEN_BYTES);

describe('bearerToken', () => {
  it('extracts the token from a well-formed header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });

  it('accepts the scheme case-insensitively and tolerates surrounding space', () => {
    expect(bearerToken('  bearer\tabc123  ')).toBe('abc123');
  });

  it('returns null for a missing, empty, or non-bearer header', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken('abc123')).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('matches an identical token of sufficient length', () => {
    expect(tokenMatches(VALID, VALID)).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(tokenMatches('b'.repeat(MIN_TOKEN_BYTES), VALID)).toBe(false);
  });

  it('rejects a prefix of the expected token', () => {
    expect(tokenMatches(VALID.slice(0, -1), VALID)).toBe(false);
  });

  it('fails closed when the configured token is unset or empty', () => {
    expect(tokenMatches(VALID, undefined)).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });

  it('refuses a configured token shorter than the minimum, even when presented exactly', () => {
    const short = 'a'.repeat(MIN_TOKEN_BYTES - 1);
    expect(tokenMatches(short, short)).toBe(false);
  });
});

describe('resolveOperatorPrincipal', () => {
  const authorization = `Bearer ${VALID}`;

  it('returns the configured user id when the token matches', () => {
    expect(
      resolveOperatorPrincipal({ authorization, token: VALID, userId: 'user-1' })
    ).toBe('user-1');
  });

  it('returns null when only the token is configured', () => {
    expect(
      resolveOperatorPrincipal({ authorization, token: VALID, userId: undefined })
    ).toBeNull();
  });

  it('returns null when only the user id is configured', () => {
    expect(
      resolveOperatorPrincipal({ authorization, token: undefined, userId: 'user-1' })
    ).toBeNull();
  });

  it('returns null for a wrong token even with a configured user id', () => {
    expect(
      resolveOperatorPrincipal({
        authorization: `Bearer ${'b'.repeat(MIN_TOKEN_BYTES)}`,
        token: VALID,
        userId: 'user-1',
      })
    ).toBeNull();
  });

  it('returns null when the request carries no Authorization header', () => {
    expect(
      resolveOperatorPrincipal({ authorization: null, token: VALID, userId: 'user-1' })
    ).toBeNull();
  });
});
