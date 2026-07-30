import { describe, expect, it } from 'vitest';
import { createTokenBucket } from '@/lib/api/client-error-limit';

describe('createTokenBucket', () => {
  it('allows a full burst then refuses', () => {
    const bucket = createTokenBucket(3, 1000, 0);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(false);
  });

  it('regains one token per refill period', () => {
    const bucket = createTokenBucket(2, 1000, 0);
    bucket.tryConsume(0);
    bucket.tryConsume(0);
    expect(bucket.tryConsume(999)).toBe(false);
    expect(bucket.tryConsume(1000)).toBe(true);
    expect(bucket.tryConsume(1000)).toBe(false);
    expect(bucket.tryConsume(2000)).toBe(true);
  });

  it('never refills past capacity after a long idle stretch', () => {
    const bucket = createTokenBucket(2, 1000, 0);
    bucket.tryConsume(0);
    bucket.tryConsume(0);
    expect(bucket.tryConsume(1_000_000)).toBe(true);
    expect(bucket.tryConsume(1_000_000)).toBe(true);
    expect(bucket.tryConsume(1_000_000)).toBe(false);
  });

  it('carries a partial period forward instead of discarding it', () => {
    const bucket = createTokenBucket(1, 1000, 0);
    bucket.tryConsume(0);
    // 1500ms grants one token and banks the 500ms remainder, so the next token
    // is due at 2000ms, not 2500ms.
    expect(bucket.tryConsume(1500)).toBe(true);
    expect(bucket.tryConsume(1999)).toBe(false);
    expect(bucket.tryConsume(2000)).toBe(true);
  });
});
