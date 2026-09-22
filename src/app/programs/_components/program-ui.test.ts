// Unit tests for buildRailTabs — the one derivation the desktop rail and the
// phone strip share. Both navigations render whatever this returns, so a bug
// here shows up twice and in two different shapes.

import { describe, it, expect } from 'vitest';
import { buildRailTabs, type RailCourse } from './program-ui';

const course = (over: Partial<RailCourse> = {}): RailCourse => ({
  trackId: 't1',
  ready: true,
  topic: 'linear-algebra',
  title: 'Linear Algebra',
  lessons: [
    { id: 'l1', title: 'Vectors', sectionId: 's1' },
    { id: 'l2', title: 'Matrices', sectionId: 's1' },
  ],
  sections: [{ id: 's1', title: 'Basics' }],
  ...over,
});

const build = (courses: RailCourse[], over: Partial<Parameters<typeof buildRailTabs>[0]> = {}) =>
  buildRailTabs({
    programId: 'p1',
    courses,
    completed: new Set<string>(),
    activeTrackId: null,
    activeLessonId: null,
    ...over,
  });

describe('buildRailTabs', () => {
  it('leads with the program overview, active only when no course is', () => {
    const [overview] = build([course()]);
    expect(overview).toMatchObject({
      key: '__overview',
      label: 'Overview',
      href: '/programs/p1',
      meta: '1/1 ready',
      active: true,
    });
    expect(build([course()], { activeTrackId: 't1' })[0].active).toBe(false);
  });

  it('counts only ready courses in the overview meta', () => {
    const tabs = build([course(), course({ trackId: 't2', topic: 'calc', ready: false })]);
    expect(tabs[0].meta).toBe('1/2 ready');
  });

  it('numbers courses in roman and carries the done fraction', () => {
    const tabs = build([course(), course({ trackId: 't2', topic: 'calc' })], {
      completed: new Set(['l1']),
    });
    expect(tabs[1].kicker).toBe('Course I · 1/2');
    expect(tabs[2].kicker).toBe('Course II · 1/2');
  });

  it('gives an unready course no href, no lessons, and a building meta', () => {
    const [, tab] = build([course({ ready: false })]);
    expect(tab.href).toBeUndefined();
    expect(tab.meta).toBe('building…');
    expect(tab.sections).toBeUndefined();
    expect(tab.lessons).toBeUndefined();
  });

  it('marks the viewed lesson current independently of completion', () => {
    const [, tab] = build([course()], {
      activeTrackId: 't1',
      activeLessonId: 'l1',
      completed: new Set(['l1']),
    });
    expect(tab.sections?.[0].lessons[0]).toMatchObject({ state: 'done', current: true });
    expect(tab.sections?.[0].lessons[1]).toMatchObject({ state: 'todo', current: false });
  });

  it('falls back to a flat lesson list when the course has no sections', () => {
    const [, tab] = build([course({ sections: [] })]);
    expect(tab.sections).toBeUndefined();
    expect(tab.lessons?.map((l) => l.href)).toEqual(['/programs/p1/t1/l1', '/programs/p1/t1/l2']);
  });

  it('falls back to the topic when a ready course has no title', () => {
    const [, tab] = build([course({ title: null })]);
    expect(tab.label).toBe('linear-algebra');
  });
});
