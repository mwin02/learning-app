import { describe, it, expect } from 'vitest';
import { carryOverProgress, type CarryOverLesson } from './progress-carryover';

const lesson = (id: string, ...conceptsTaught: string[]): CarryOverLesson => ({ id, conceptsTaught });

describe('carryOverProgress', () => {
  it('carries an exact concept match', () => {
    const done = [lesson('old1', 'limits', 'continuity')];
    const next = [lesson('new1', 'limits', 'continuity'), lesson('new2', 'integrals')];
    expect(carryOverProgress(done, next)).toEqual(['new1']);
  });

  it('carries when the new lesson is a SPLIT of a completed one', () => {
    // One finished lesson taught three concepts; the rebuild teaches them as three
    // narrower lessons. Each is fully contained in work already done, so all three
    // carry — this is the case a union/Jaccard rule would drop on the floor.
    const done = [lesson('old1', 'limits', 'continuity', 'derivatives')];
    const next = [lesson('new1', 'limits'), lesson('new2', 'continuity'), lesson('new3', 'derivatives')];
    expect(carryOverProgress(done, next)).toEqual(['new1', 'new2', 'new3']);
  });

  it('carries when the new lesson MERGES several completed ones', () => {
    // Coverage is the union over every completed lesson, not a best-single match:
    // no old lesson alone covers half of new1, but together they cover 3 of 4.
    const done = [lesson('old1', 'limits', 'continuity'), lesson('old2', 'derivatives')];
    const next = [lesson('new1', 'limits', 'continuity', 'derivatives', 'chain-rule')];
    expect(carryOverProgress(done, next)).toEqual(['new1']);
  });

  it('carries a half-covered lesson and drops one below half', () => {
    const done = [lesson('old1', 'limits')];
    expect(carryOverProgress(done, [lesson('half', 'limits', 'continuity')])).toEqual(['half']);
    expect(carryOverProgress(done, [lesson('third', 'limits', 'continuity', 'derivatives')])).toEqual([]);
  });

  it('carries nothing when the concept sets do not overlap', () => {
    const done = [lesson('old1', 'limits', 'continuity')];
    expect(carryOverProgress(done, [lesson('new1', 'eigenvalues', 'rank')])).toEqual([]);
  });

  it('ignores casing and whitespace drift between two composes of the same Path', () => {
    const done = [lesson('old1', 'Limits ', 'CONTINUITY')];
    expect(carryOverProgress(done, [lesson('new1', 'limits', 'continuity')])).toEqual(['new1']);
  });

  it('carries nothing from an empty completed set, and never carries a lesson that teaches nothing', () => {
    expect(carryOverProgress([], [lesson('new1', 'limits')])).toEqual([]);
    expect(carryOverProgress([lesson('old1', 'limits')], [lesson('empty')])).toEqual([]);
  });
});
