import { describe, expect, it, vi } from 'vitest';

// models.ts's vertex leaf throws at module-eval without GOOGLE_VERTEX_PROJECT.
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  vertexAnthropic: {},
  vertexGlobal: {},
}));

import { FLASH_MODEL_ID, PRO_MODEL_ID } from '@/lib/ai/models';
import { ARMS } from '@/lib/ai/model-compare';
import { seededRng } from '@/lib/ai/bank-compare';
import type { CompareCallRecord } from '@/lib/ai/compare-scope';
import type { ValidatedLesson } from '@/lib/agents/track/validate-composition';
import {
  composerBars,
  extractRecord,
  lastCompletedRun,
  lessonJaccard,
  sideBySide,
  summarizeBaseline,
  summarizeRun,
  type CompositionOutcome,
  type CompositionRecord,
} from '@/lib/ai/composer-compare';

const ARM_OR_MODEL = new RegExp([...Object.keys(ARMS), PRO_MODEL_ID, FLASH_MODEL_ID, '\\bflash\\b', '\\bpro\\b'].join('|'), 'i');

function call(modelId: string, durationMs: number, outcome: CompareCallRecord['outcome'] = 'ok'): CompareCallRecord {
  // A failed attempt carries no usage.
  const usage = outcome === 'ok' ? { inputTokens: 1_000_000, outputTokens: 0 } : {};
  return { agent: 'trackComposer', modelId, durationMs, outcome, ...usage, webSearchQueries: 0 };
}

const record = (over: Partial<CompositionRecord> = {}): CompositionRecord => ({
  lessonConceptSets: [['a'], ['b'], ['c']],
  intent: 'learn',
  enough: true,
  thinForBudget: 0,
  needsThicken: false,
  fallbackWarnings: 0,
  trackTitle: 'Title',
  trackSummary: 'Summary',
  lessons: [{ title: 'L1', summary: 'S1' }],
  ...over,
});
const thickens = (over: Partial<CompositionRecord> = {}) => record({ enough: false, needsThicken: true, ...over });

const outcome = (id: string, r: CompositionRecord | null, calls: CompareCallRecord[] = [call(PRO_MODEL_ID, 40_000)]): CompositionOutcome => ({
  compositionId: id,
  record: r,
  composerCalls: calls,
  ...(r === null ? { error: 'boom' } : {}),
});

const lesson = (conceptSlugs: string[], title = 'T'): ValidatedLesson => ({
  conceptSlugs,
  timeWeight: 'normal',
  mandatoryResourceIds: ['r1'],
  optionalResourceIds: [],
  title,
  summary: `${title} summary`,
  isFrontier: false,
  masteryRelevant: false,
});

describe('extractRecord', () => {
  it('records sorted lesson concept-sets, the thicken decision and primary-fallback warnings only', () => {
    const r = extractRecord(
      {
        intent: 'exam_prep',
        trackTitle: 'Cram',
        trackSummary: 'Fast',
        resourceSufficiency: { enough: true, underResourced: [], thinForBudget: [{ conceptSlug: 'b', reason: 'thin' }] },
      },
      {
        lessons: [lesson(['b', 'a'], 'AB'), lesson(['c'], 'C')],
        warnings: [
          "lesson [c]: composer mandatory invalid/absent, fell back to top candidate",
          "omitted spine concept 'x' for intent: cram",
        ],
      },
    );
    expect(r.lessonConceptSets).toEqual([['a', 'b'], ['c']]);
    expect(r).toMatchObject({ intent: 'exam_prep', enough: true, thinForBudget: 1, needsThicken: true, fallbackWarnings: 1 });
    expect(r.lessons).toEqual([{ title: 'AB', summary: 'AB summary' }, { title: 'C', summary: 'C summary' }]);
  });

  it('thickens when not enough, even with no budget-thin concept', () => {
    const r = extractRecord(
      { intent: 'learn', trackTitle: 't', trackSummary: 's', resourceSufficiency: { enough: false, underResourced: [], thinForBudget: [] } },
      { lessons: [lesson(['a'])], warnings: [] },
    );
    expect(r.needsThicken).toBe(true);
  });
});

describe('lessonJaccard', () => {
  it('scores the same lessons as 1 and penalises a regrouping, not just a missing concept', () => {
    expect(lessonJaccard(record(), record())).toBe(1);
    // {a,b,c} vs {a+b, c}: one shared lesson of four distinct.
    expect(lessonJaccard(record(), record({ lessonConceptSets: [['a', 'b'], ['c']] }))).toBeCloseTo(1 / 4);
    expect(lessonJaccard(record(), record({ lessonConceptSets: [['a'], ['b']] }))).toBeCloseTo(2 / 3);
  });
});

describe('summarizeRun', () => {
  const run1 = [outcome('1', record()), outcome('2', thickens()), outcome('3', null), outcome('4', record({ intent: 'review' }))];
  const run2 = [outcome('1', record()), outcome('2', thickens()), outcome('3', record()), outcome('4', record())];

  it('counts an arm failure as a disagreement and skips compositions baseline run 1 failed', () => {
    const arm = [outcome('1', record()), outcome('2', null), outcome('3', record()), outcome('4', record({ intent: 'review' }))];
    const m = summarizeRun(arm, run1, run2);
    expect(m.compared).toBe(3);
    expect(m.errors).toBe(1);
    expect(m.meanJaccard).toBeCloseTo(2 / 3);
    expect(m.thickenAgreement).toBeCloseTo(2 / 3);
    expect(m.intentAgreement).toBeCloseTo(2 / 3);
    // A failed composition is not a "no thicken" decision.
    expect(m.skippedThickens).toBe(0);
  });

  it('counts a no-thicken only where both baseline runs thickened', () => {
    const arm = [outcome('1', record()), outcome('2', record()), outcome('3', record()), outcome('4', record())];
    expect(summarizeRun(arm, run1, run2).skippedThickens).toBe(1);
    const run2NoThicken = [outcome('2', record())];
    expect(summarizeRun(arm, run1, run2NoThicken).skippedThickens).toBe(0);
  });

  it('matches the thicken decision on enough and on thinForBudget being non-empty', () => {
    const ref = [outcome('1', thickens({ enough: true, thinForBudget: 2 }))];
    const same = [outcome('1', thickens({ enough: true, thinForBudget: 1 }))];
    const differs = [outcome('1', thickens({ enough: false, thinForBudget: 0 }))];
    expect(summarizeRun(same, ref, ref).thickenAgreement).toBe(1);
    expect(summarizeRun(differs, ref, ref).thickenAgreement).toBe(0);
  });

  it('takes latency from ok attempts only and prices composer calls per composition', () => {
    const arm = [
      outcome('1', record(), [call(FLASH_MODEL_ID, 300, 'error'), call(FLASH_MODEL_ID, 8_000)]),
      outcome('2', record(), [call(FLASH_MODEL_ID, 12_000)]),
    ];
    const m = summarizeRun(arm, arm, arm);
    expect(m.p50LatencyMs).toBe(10_000);
    expect(m.maxLatencyMs).toBe(12_000);
    expect(m.failedAttempts).toBe(1);
    // Two 1M-input-token Flash calls over two compositions.
    expect(m.usdPerComposition).toEqual({ pro: null, flashIntro: 0.75, flash2027: 1.5 });
  });
});

describe('summarizeBaseline', () => {
  it('excludes a composition either run failed from the yardstick and pools latency', () => {
    const run1 = [outcome('1', record(), [call(PRO_MODEL_ID, 10_000)]), outcome('2', null, []), outcome('3', record())];
    const run2 = [
      outcome('1', record({ lessonConceptSets: [['a'], ['b']] }), [call(PRO_MODEL_ID, 30_000)]),
      outcome('2', record()),
      outcome('3', record(), [call(PRO_MODEL_ID, 50_000)]),
    ];
    const b = summarizeBaseline(run1, run2);
    expect(b.bothValid).toBe(2);
    expect(b.yardstick).toBeCloseTo((2 / 3 + 1) / 2);
    expect(b.p50LatencyMs).toBe(40_000);
    expect(b.run1.errors).toBe(1);
  });
});

describe('composerBars', () => {
  const ids = ['1', '2', '3', '4'];
  const base = summarizeBaseline(
    ids.map((id) => outcome(id, record())),
    ids.map((id) => outcome(id, record())),
  );
  const fast = (r: CompositionRecord | null) => outcome('x', r, [call(FLASH_MODEL_ID, 10_000)]);
  const armOf = (records: (CompositionRecord | null)[]) =>
    summarizeRun(records.map((r, i) => ({ ...fast(r), compositionId: ids[i] })), ids.map((id) => outcome(id, record())), ids.map((id) => outcome(id, record())));

  it('passes an arm that agrees and is fast', () => {
    const { verdict, bars } = composerBars(armOf([record(), record(), record(), record()]), base);
    expect(bars.every((b) => b.pass)).toBe(true);
    expect(verdict).toBe('PASS');
  });

  it('fails on Jaccard, intent, warnings or latency against their thresholds', () => {
    const regrouped = record({ lessonConceptSets: [['a', 'b', 'c']] });
    expect(composerBars(armOf([regrouped, regrouped, record(), record()]), base).verdict).toBe('FAIL');
    const review = record({ intent: 'review' });
    expect(composerBars(armOf([review, review, record(), record()]), base).verdict).toBe('FAIL');
    const warns = record({ fallbackWarnings: 1 });
    expect(composerBars(armOf([warns, warns, record(), record()]), base).verdict).toBe('FAIL');
    const slow = summarizeRun(ids.map((id) => outcome(id, record(), [call(PRO_MODEL_ID, 30_000)])), [], []);
    expect(composerBars({ ...slow, meanJaccard: 1, thickenAgreement: 1, intentAgreement: 1 }, base).verdict).toBe('FAIL');
  });

  it('fails an arm that skipped a thicken both baselines ran, whatever the other bars say', () => {
    // Five compositions, so one disagreement still clears the 80% agreement bar.
    const five = [...ids, '5'];
    const thickBase = summarizeBaseline(five.map((id) => outcome(id, thickens())), five.map((id) => outcome(id, thickens())));
    const arm = summarizeRun(
      five.map((id, i) => ({ ...fast(i === 0 ? record() : thickens()), compositionId: id })),
      five.map((id) => outcome(id, thickens())),
      five.map((id) => outcome(id, thickens())),
    );
    const { verdict, bars } = composerBars(arm, thickBase);
    expect(bars.filter((b) => !b.pass).map((b) => b.name)).toEqual(['no thicken where both baselines thickened = 0']);
    expect(verdict).toBe('FAIL');
  });

  it('is INCONCLUSIVE when a baseline run produced nothing or there is no yardstick', () => {
    const arm = armOf([record(), record(), record(), record()]);
    const noRun2 = summarizeBaseline(ids.map((id) => outcome(id, record())), []);
    expect(composerBars(arm, noRun2).verdict).toBe('INCONCLUSIVE');
    const allFailed = summarizeBaseline(ids.map((id) => outcome(id, null, [])), ids.map((id) => outcome(id, record())));
    expect(composerBars(arm, allFailed).verdict).toBe('INCONCLUSIVE');
    const disjoint = summarizeBaseline(
      [outcome('1', record()), outcome('2', null)],
      [outcome('1', null), outcome('2', record())],
    );
    const res = composerBars(arm, disjoint);
    expect(res.verdict).toBe('INCONCLUSIVE');
    expect(res.reason).toMatch(/yardstick/);
  });
});

describe('sideBySide', () => {
  const items = ['calculus · exam cram', 'operating-systems · beginner', 'calculus · grad refresh', 'operating-systems · refresh'].map((heading, i) => ({
    compositionId: `c${i}`,
    heading,
    learner: 'Goal: something',
    baseline: record({ trackTitle: `Baseline ${i}` }),
    candidate: record({ trackTitle: `Candidate ${i}` }),
  }));

  it('keys every section to both sides, deterministically under a seed', () => {
    const { markdown, key } = sideBySide(items, 'flash-low', seededRng(5));
    expect(sideBySide(items, 'flash-low', seededRng(5)).key).toEqual(key);
    expect(Object.keys(key)).toHaveLength(4);
    for (const [id, k] of Object.entries(key)) {
      expect(markdown).toContain(`## ${id} ·`);
      expect([k.A, k.B].sort()).toEqual(['baseline', 'flash-low']);
      const n = k.compositionId.slice(1);
      const section = markdown.split(`## ${id} ·`)[1].split('\n## ')[0];
      const [aPart, bPart] = section.split('### B');
      expect(aPart).toContain(k.A === 'baseline' ? `Baseline ${n}` : `Candidate ${n}`);
      expect(bPart).toContain(k.B === 'baseline' ? `Baseline ${n}` : `Candidate ${n}`);
    }
  });

  it('names no arm or model and does not always put the baseline on the same side', () => {
    const { markdown: md, key } = sideBySide(
      items.map((i) => ({ ...i, baseline: record(), candidate: record() })),
      'pro-low',
      seededRng(11),
    );
    expect(md).not.toMatch(ARM_OR_MODEL);
    const runs = Array.from({ length: 20 }, (_, s) => Object.values(sideBySide(items, 'pro-low', seededRng(s)).key).map((k) => k.A));
    expect(new Set(runs.flat()).size).toBe(2);
    expect(Object.values(key).length).toBe(4);
  });
});

describe('lastCompletedRun', () => {
  it('reads back the last completed run, ignoring an unfinished later one', () => {
    const base = summarizeBaseline([outcome('1', record())], [outcome('1', record())]);
    const metrics = summarizeRun([outcome('1', record())], [], []);
    const verdict = (runId: string, arm: string) => ({ kind: 'verdict', runId, arm, verdict: 'FAIL', bars: [], metrics, baseline: base });
    const rows: unknown[] = [
      { kind: 'run-start', runId: 'a' },
      verdict('a', 'flash-low'),
      verdict('a', 'flash-default'),
      { kind: 'run-end', runId: 'a', candidate: 'flash-default' },
      { kind: 'run-start', runId: 'b' },
      verdict('b', 'flash-low'),
    ];
    const run = lastCompletedRun(JSON.parse(JSON.stringify(rows)));
    expect(run?.runId).toBe('a');
    expect(run?.candidate).toBe('flash-default');
    expect(run?.verdicts.map((v) => v.arm)).toEqual(['flash-low', 'flash-default']);
    expect(lastCompletedRun([{ kind: 'run-start', runId: 'x' }])).toBeNull();
  });
});
