import { describe, it, expect } from 'vitest';
import {
  carryOverProgress,
  type CarryOverLesson,
  type CompletedCarryOverLesson,
} from './progress-carryover';

const lesson = (id: string, ...conceptsTaught: string[]): CarryOverLesson => ({ id, conceptsTaught });

// A day in 2026, so the assertions read as calendar dates rather than epoch noise.
const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const done = (id: string, at: number, ...conceptsTaught: string[]): CompletedCarryOverLesson => ({
  id,
  conceptsTaught,
  completedAt: day(at),
});

const ids = (carried: { id: string }[]) => carried.map((c) => c.id);

describe('carryOverProgress', () => {
  it('carries an exact concept match', () => {
    const completed = [done('old1', 1, 'limits', 'continuity')];
    const next = [lesson('new1', 'limits', 'continuity'), lesson('new2', 'integrals')];
    expect(carryOverProgress(completed, next)).toEqual([
      { id: 'new1', completedAt: day(1), fromLessonId: 'old1' },
    ]);
  });

  it('carries when the new lesson is a SPLIT of a completed one', () => {
    // One finished lesson taught three concepts; the rebuild teaches them as three
    // narrower lessons. Each is fully contained in work already done, so all three
    // carry — this is the case a union/Jaccard rule would drop on the floor.
    const completed = [done('old1', 1, 'limits', 'continuity', 'derivatives')];
    const next = [lesson('new1', 'limits'), lesson('new2', 'continuity'), lesson('new3', 'derivatives')];
    expect(ids(carryOverProgress(completed, next))).toEqual(['new1', 'new2', 'new3']);
  });

  it('carries when the new lesson MERGES several completed ones', () => {
    // Coverage is the union over every completed lesson, not a best-single match:
    // no old lesson alone covers half of new1, but together they cover 3 of 4.
    const completed = [done('old1', 1, 'limits', 'continuity'), done('old2', 2, 'derivatives')];
    const next = [lesson('new1', 'limits', 'continuity', 'derivatives', 'chain-rule')];
    expect(ids(carryOverProgress(completed, next))).toEqual(['new1']);
  });

  it('carries a half-covered lesson and drops one below half', () => {
    const completed = [done('old1', 1, 'limits')];
    expect(ids(carryOverProgress(completed, [lesson('half', 'limits', 'continuity')]))).toEqual(['half']);
    expect(carryOverProgress(completed, [lesson('third', 'limits', 'continuity', 'derivatives')])).toEqual([]);
  });

  it('carries nothing when the concept sets do not overlap', () => {
    const completed = [done('old1', 1, 'limits', 'continuity')];
    expect(carryOverProgress(completed, [lesson('new1', 'eigenvalues', 'rank')])).toEqual([]);
  });

  it('ignores casing and whitespace drift between two composes of the same Path', () => {
    const completed = [done('old1', 1, 'Limits ', 'CONTINUITY')];
    expect(ids(carryOverProgress(completed, [lesson('new1', 'limits', 'continuity')]))).toEqual(['new1']);
  });

  it('carries nothing from an empty completed set, and never carries a lesson that teaches nothing', () => {
    expect(carryOverProgress([], [lesson('new1', 'limits')])).toEqual([]);
    expect(carryOverProgress([done('old1', 1, 'limits')], [lesson('empty')])).toEqual([]);
  });

  it('dates a merged lesson by the LAST completion that covered it, and credits that lesson', () => {
    // The learner did not finish this lesson's material until the later of the two —
    // the earlier one alone did not cover it. F5: this timestamp is what the insert
    // writes, and fromLessonId is the evidence that marks the row as carried rather
    // than earned, so completion-event consumers can leave it out.
    const completed = [done('old1', 3, 'limits'), done('old2', 9, 'continuity')];
    expect(carryOverProgress(completed, [lesson('new1', 'limits', 'continuity')])).toEqual([
      { id: 'new1', completedAt: day(9), fromLessonId: 'old2' },
    ]);
  });

  it('dates each half of a split by the completion it came from', () => {
    const completed = [done('old1', 2, 'limits'), done('old2', 20, 'derivatives')];
    expect(carryOverProgress(completed, [lesson('a', 'limits'), lesson('b', 'derivatives')])).toEqual([
      { id: 'a', completedAt: day(2), fromLessonId: 'old1' },
      { id: 'b', completedAt: day(20), fromLessonId: 'old2' },
    ]);
  });

  it('ignores completions of concepts the new lesson does not teach when dating it', () => {
    // old2 is later but contributes nothing to new1's coverage, so it must not drag
    // new1's date forward onto the rebuild's own week — nor claim the credit.
    const completed = [done('old1', 4, 'limits'), done('old2', 28, 'eigenvalues')];
    expect(carryOverProgress(completed, [lesson('new1', 'limits')])).toEqual([
      { id: 'new1', completedAt: day(4), fromLessonId: 'old1' },
    ]);
  });
});
