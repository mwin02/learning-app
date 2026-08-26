import { describe, expect, it } from 'vitest';
import type { TrackResourceView } from '@/lib/track-view';
import {
  buildLessonResourcesView,
  coreProgressLine,
  deliveryOf,
  lessonMetaLine,
} from '@/lib/lesson-resources-view';

function res(
  id: string,
  over: Partial<TrackResourceView> & { durationMin?: number | null; content?: string | null } = {},
): TrackResourceView {
  const { durationMin = null, content = null, ...rest } = over;
  return {
    id,
    role: 'primary',
    deliveryMode: 'embed',
    segmentRef: null,
    resource: {
      id: `r-${id}`,
      title: `Resource ${id}`,
      url: `https://example.com/${id}`,
      type: 'video',
      content,
      durationMin,
    },
    ...rest,
  };
}

describe('deliveryOf', () => {
  it('calls a generated row a handout whatever its delivery mode says', () => {
    expect(deliveryOf(res('a', { content: '# body', deliveryMode: 'embed' }))).toBe('handout');
  });

  it('maps embed and everything else', () => {
    expect(deliveryOf(res('a', { deliveryMode: 'embed' }))).toBe('embed');
    expect(deliveryOf(res('a', { deliveryMode: 'newtab' }))).toBe('newtab');
    expect(deliveryOf(res('a', { deliveryMode: 'native' }))).toBe('newtab');
  });
});

describe('buildLessonResourcesView', () => {
  it('splits cores from alternates and numbers the rail in order', () => {
    const view = buildLessonResourcesView([
      res('1'),
      res('2', { deliveryMode: 'newtab' }),
      res('3', { role: 'alternate' }),
    ]);
    expect(view.cores.map((r) => r.id)).toEqual(['1', '2']);
    expect(view.alternates.map((r) => r.id)).toEqual(['3']);
    expect(view.rail.map((r) => r.n)).toEqual([1, 2]);
  });

  it('promotes the first resource when a lesson has no primary row', () => {
    const view = buildLessonResourcesView([
      res('1', { role: 'alternate' }),
      res('2', { role: 'alternate' }),
    ]);
    expect(view.cores.map((r) => r.id)).toEqual(['1']);
    expect(view.alternates.map((r) => r.id)).toEqual(['2']);
  });

  it('returns empty everything for a lesson with no resources', () => {
    const view = buildLessonResourcesView([]);
    expect(view.cores).toEqual([]);
    expect(view.rail).toEqual([]);
    expect(view.optionalSummary).toBeNull();
  });

  it('prints a duration in the rail meta only when the library measured one', () => {
    const view = buildLessonResourcesView([
      res('1', { durationMin: 12 }),
      res('2', { deliveryMode: 'newtab' }),
    ]);
    expect(view.rail[0].meta).toBe('embed · ~12 min');
    expect(view.rail[1].meta).toBe('opens new tab');
  });

  it('counts the optional pool without breaking it down by delivery', () => {
    const view = buildLessonResourcesView([
      res('1'),
      res('2', { role: 'alternate', deliveryMode: 'newtab' }),
      res('3', { role: 'alternate', deliveryMode: 'newtab' }),
      res('4', { role: 'alternate', deliveryMode: 'embed' }),
    ]);
    expect(view.optionalSummary).toBe('3 extras');
  });

  it('singularizes a lone extra', () => {
    const view = buildLessonResourcesView([res('1'), res('2', { role: 'alternate' })]);
    expect(view.optionalSummary).toBe('1 extra');
  });
});

describe('lessonMetaLine', () => {
  it('joins the three clauses', () => {
    expect(lessonMetaLine({ estMinutes: 35, coreCount: 3, exerciseCount: 5 })).toBe(
      '~35 min · 3 core resources · 5 questions',
    );
  });

  it('drops zero-count clauses instead of printing "0 questions"', () => {
    expect(lessonMetaLine({ estMinutes: 10, coreCount: 1, exerciseCount: 0 })).toBe(
      '~10 min · 1 core resource',
    );
  });
});

describe('coreProgressLine', () => {
  it('adds the "work through all N" clause only for multi-core lessons', () => {
    expect(coreProgressLine(1, 3)).toBe('1 of 3 done · work through all 3');
    expect(coreProgressLine(0, 1)).toBe('0 of 1 done');
  });
});
