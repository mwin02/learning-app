// Unit tests for R4's pure parts: the grouping/ranking of open reports into an
// operator queue, and the `resolution` composition rule that lets the operator's
// outcome and R2's probe verdict share one column. The delegated remediation
// (applyPendingReview, setPrimaryTopic, updateResource, recomputeReadiness) each
// has its own coverage — what R4 owns is the routing and the ordering.
//
// Prisma is stubbed: @/lib/db validates env at module-eval (testing.md).

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { groupReports, composeResolution, type TriageReportRow } from '@/lib/curation/report-triage';
import { actionsForCategory } from '@/lib/report-triage-view';

let seq = 0;
const row = (over: Partial<TriageReportRow> = {}): TriageReportRow => ({
  id: `rep_${seq++}`,
  userId: 'user_a',
  resourceId: 'res_1',
  category: 'dead_link',
  note: null,
  resolution: null,
  lessonId: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

const at = (iso: string) => new Date(iso);

describe('groupReports', () => {
  it('groups by resource, then by category', () => {
    const groups = groupReports([
      row({ resourceId: 'res_1', category: 'dead_link', userId: 'u1' }),
      row({ resourceId: 'res_1', category: 'wrong_topic', userId: 'u2' }),
      row({ resourceId: 'res_2', category: 'dead_link', userId: 'u1' }),
    ]);
    expect(groups.map((g) => g.resourceId).sort()).toEqual(['res_1', 'res_2']);
    const res1 = groups.find((g) => g.resourceId === 'res_1');
    expect(res1?.categories.map((c) => c.category).sort()).toEqual(['dead_link', 'wrong_topic']);
  });

  it('counts rows as distinct reporters per category (the composite unique guarantees it)', () => {
    const groups = groupReports([
      row({ category: 'dead_link', userId: 'u1' }),
      row({ category: 'dead_link', userId: 'u2' }),
      row({ category: 'dead_link', userId: 'u3' }),
    ]);
    expect(groups[0].categories[0].reporters).toBe(3);
  });

  it('counts one person reporting two categories as one reporter for the resource', () => {
    const groups = groupReports([
      row({ category: 'dead_link', userId: 'u1' }),
      row({ category: 'low_quality', userId: 'u1' }),
    ]);
    expect(groups[0].reporters).toBe(1);
    expect(groups[0].categories).toHaveLength(2);
  });

  it('ranks resources by distinct reporters, then by age', () => {
    const groups = groupReports([
      row({ resourceId: 'lonely_old', userId: 'u1', createdAt: at('2026-01-01T00:00:00Z') }),
      row({ resourceId: 'popular', userId: 'u1', createdAt: at('2026-07-01T00:00:00Z') }),
      row({ resourceId: 'popular', userId: 'u2', createdAt: at('2026-07-02T00:00:00Z') }),
      row({ resourceId: 'lonely_new', userId: 'u1', createdAt: at('2026-07-05T00:00:00Z') }),
    ]);
    expect(groups.map((g) => g.resourceId)).toEqual(['popular', 'lonely_old', 'lonely_new']);
  });

  it('ranks a resource’s categories the same way and puts the oldest report first', () => {
    const groups = groupReports([
      row({ category: 'low_quality', userId: 'u1', createdAt: at('2026-02-01T00:00:00Z') }),
      row({ category: 'dead_link', userId: 'u1', createdAt: at('2026-06-01T00:00:00Z') }),
      row({ category: 'dead_link', userId: 'u2', createdAt: at('2026-05-01T00:00:00Z') }),
    ]);
    expect(groups[0].categories.map((c) => c.category)).toEqual(['dead_link', 'low_quality']);
    expect(groups[0].categories[0].reports[0].createdAt).toEqual(at('2026-05-01T00:00:00Z'));
    expect(groups[0].oldestAt).toEqual(at('2026-02-01T00:00:00Z'));
  });

  it('collects the distinct lessons a resource was reported from, dropping nulls', () => {
    const groups = groupReports([
      row({ userId: 'u1', lessonId: 'les_1' }),
      row({ userId: 'u2', lessonId: 'les_1' }),
      row({ userId: 'u3', lessonId: null }),
      row({ userId: 'u4', lessonId: 'les_2' }),
    ]);
    expect(groups[0].lessonIds).toEqual(['les_1', 'les_2']);
  });

  it('is empty for no reports', () => {
    expect(groupReports([])).toEqual([]);
  });
});

describe('composeResolution', () => {
  it('is just the outcome when there is nothing else to say', () => {
    expect(composeResolution('dismissed — not a defect')).toBe('dismissed — not a defect');
  });

  it('preserves R2’s probe verdict behind the operator’s outcome', () => {
    expect(composeResolution('deprecated (hard)', { prior: 'url not reachable' })).toBe(
      'deprecated (hard) · probe: url not reachable',
    );
  });

  it('puts the operator note between the outcome and the probe verdict', () => {
    expect(
      composeResolution('deprecated (hard)', { note: 'confirmed in a browser', prior: 'url alive' }),
    ).toBe('deprecated (hard) · confirmed in a browser · probe: url alive');
  });

  it('ignores blank notes and verdicts', () => {
    expect(composeResolution('edited title', { note: '  ', prior: null })).toBe('edited title');
  });
});

describe('actionsForCategory', () => {
  // The locked rule from the plan: a placement defect must never be able to
  // deprecate a good resource globally.
  it('offers wrong_lesson_fit unlink and never a deprecation', () => {
    const actions = actionsForCategory('wrong_lesson_fit');
    expect(actions[0]).toBe('unlink');
    expect(actions).not.toContain('deprecate_hard');
    expect(actions).not.toContain('deprecate_soft');
  });

  it('routes each category to its own remediation axis', () => {
    expect(actionsForCategory('dead_link')[0]).toBe('deprecate_hard');
    expect(actionsForCategory('wrong_topic')[0]).toBe('refile');
    expect(actionsForCategory('wrong_duration')[0]).toBe('edit');
    expect(actionsForCategory('wrong_difficulty')[0]).toBe('edit');
  });

  // A wrong access flag is a field defect: `requiresPurchase` is whitelisted, so
  // correcting it must outrank throwing the resource away.
  it('recommends the field fix for paywalled, keeping deprecation available after it', () => {
    const actions = actionsForCategory('paywalled');
    expect(actions[0]).toBe('edit');
    expect(actions).toContain('deprecate_soft');
    expect(actions.indexOf('edit')).toBeLessThan(actions.indexOf('deprecate_soft'));
  });

  it('always offers a way out', () => {
    const categories = [
      'dead_link',
      'wrong_topic',
      'wrong_lesson_fit',
      'wrong_duration',
      'wrong_difficulty',
      'paywalled',
      'low_quality',
      'other',
    ] as const;
    for (const c of categories) expect(actionsForCategory(c)).toContain('dismiss');
  });
});
