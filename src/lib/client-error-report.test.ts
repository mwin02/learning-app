import { beforeEach, describe, expect, it } from 'vitest';
import { resetClientErrorReporting, shouldReport } from '@/lib/client-error-report';

beforeEach(() => {
  resetClientErrorReporting();
});

describe('shouldReport', () => {
  it('reports a first-seen error', () => {
    expect(shouldReport({ message: 'boom' })).toBe(true);
  });

  it('suppresses an identical repeat (a remounting boundary)', () => {
    expect(shouldReport({ message: 'boom', stack: 'at f' })).toBe(true);
    expect(shouldReport({ message: 'boom', stack: 'at f' })).toBe(false);
  });

  it('treats a differing stack as a different crash', () => {
    expect(shouldReport({ message: 'boom', stack: 'at f' })).toBe(true);
    expect(shouldReport({ message: 'boom', stack: 'at g' })).toBe(true);
  });

  it('dedupes on digest alone when present, ignoring the redacted message', () => {
    expect(shouldReport({ message: 'An error occurred', digest: '123' })).toBe(true);
    expect(shouldReport({ message: 'different text', digest: '123' })).toBe(false);
  });

  it('caps distinct reports per page load', () => {
    expect(shouldReport({ message: 'a' })).toBe(true);
    expect(shouldReport({ message: 'b' })).toBe(true);
    expect(shouldReport({ message: 'c' })).toBe(true);
    expect(shouldReport({ message: 'd' })).toBe(false);
  });
});
