// Library-quality Q2 — the duration write-path rules. Pure: no DB, no LLM.

import { describe, it, expect } from 'vitest';
import { MAX_ATTACHABLE_DURATION_MIN } from '@/lib/config';
import {
  checkDuration,
  containerDuration,
  MIN_MULTI_UNIT_DURATION_MIN,
  type DurationClaim,
} from './duration-rules';

const claim = (over: Partial<DurationClaim>): DurationClaim => ({
  type: 'article',
  durationMin: 30,
  decompositionStatus: 'atomic',
  childCount: 0,
  ...over,
});

describe('checkDuration', () => {
  it('accepts a null duration — unknown is an honest answer', () => {
    expect(checkDuration(claim({ type: 'book', durationMin: null })).ok).toBe(true);
  });

  it('rejects a book at 20 minutes (the library\'s placeholder value)', () => {
    const verdict = checkDuration(claim({ type: 'book', durationMin: 20 }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('placeholder');
  });

  it('accepts a book at 400 minutes', () => {
    expect(checkDuration(claim({ type: 'book', durationMin: 400 })).ok).toBe(true);
  });

  it('rejects a multi-unit course under the floor but accepts a single-unit one', () => {
    const multi = { type: 'course', durationMin: 20, decompositionStatus: 'decomposed', childCount: 12 };
    expect(checkDuration(claim(multi)).ok).toBe(false);
    // One 20-minute unit of course material is a real thing; a 12-lesson course is not.
    expect(checkDuration(claim({ ...multi, decompositionStatus: 'atomic', childCount: 0 })).ok).toBe(true);
  });

  it('accepts a multi-unit work exactly at the floor', () => {
    expect(
      checkDuration(claim({ type: 'book', durationMin: MIN_MULTI_UNIT_DURATION_MIN })).ok,
    ).toBe(true);
  });

  it('rejects an atomic leaf above the attachable ceiling', () => {
    const verdict = checkDuration(
      claim({ type: 'video', durationMin: MAX_ATTACHABLE_DURATION_MIN + 1 }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('ceiling');
  });

  it('accepts an atomic leaf exactly at the ceiling', () => {
    expect(
      checkDuration(claim({ type: 'video', durationMin: MAX_ATTACHABLE_DURATION_MIN })).ok,
    ).toBe(true);
  });

  it('lets a decomposed container exceed the ceiling — it is never attached whole', () => {
    expect(
      checkDuration(
        claim({
          type: 'course',
          durationMin: 1800,
          decompositionStatus: 'decomposed',
          childCount: 20,
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts the ordinary rows the gate must not disturb', () => {
    expect(checkDuration(claim({ type: 'article', durationMin: 12 })).ok).toBe(true);
    expect(checkDuration(claim({ type: 'video', durationMin: 3 })).ok).toBe(true);
    expect(checkDuration(claim({ type: 'docs', durationMin: 45 })).ok).toBe(true);
  });
});

describe('containerDuration', () => {
  it('sums the children it knows and calls the result an estimate', () => {
    expect(
      containerDuration([{ durationMin: 15 }, { durationMin: 25 }, { durationMin: null }]),
    ).toEqual({ durationMin: 40, durationSource: 'estimated' });
  });

  it('is unknown when no child has a duration', () => {
    expect(containerDuration([{ durationMin: null }, { durationMin: null }])).toEqual({
      durationMin: null,
      durationSource: 'unknown',
    });
  });

  it('is unknown for a childless container', () => {
    expect(containerDuration([])).toEqual({ durationMin: null, durationSource: 'unknown' });
  });
});
