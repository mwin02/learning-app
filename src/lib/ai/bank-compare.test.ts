import { describe, expect, it, vi } from 'vitest';
import { APICallError, RetryError } from 'ai';

// models.ts's vertex leaf throws at module-eval without GOOGLE_VERTEX_PROJECT.
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  vertexAnthropic: {},
  vertexGlobal: {},
}));

import { FLASH_MODEL_ID, PRO_MODEL_ID } from '@/lib/ai/models';
import { ARMS } from '@/lib/ai/model-compare';
import type { CompareCallRecord } from '@/lib/ai/compare-scope';
import {
  bankBars,
  blindSample,
  buildGraderPrompt,
  count429s,
  finalVerdict,
  GRADER_SYSTEM_PROMPT,
  lastCompletedRun,
  parseGrades,
  parseHumanRead,
  seededRng,
  shuffle,
  summarizeBanks,
  type BankInputResult,
  type BankRunMetrics,
  type QuestionGrade,
} from '@/lib/ai/bank-compare';

const ARM_OR_MODEL = new RegExp([...Object.keys(ARMS), PRO_MODEL_ID, FLASH_MODEL_ID, '\\bflash\\b', '\\bpro\\b'].join('|'), 'i');

const question = (n: number) => ({ kind: 'mcq', prompt: `What is ${n}?\nA) one\nB) two`, answer: 'A) one', rubric: 'Because.' });
const ok: QuestionGrade = { answerKeyCorrect: true, inScope: true, note: 'ok' };
const wrongKey: QuestionGrade = { answerKeyCorrect: false, inScope: true, note: 'key is B' };
const outOfScope: QuestionGrade = { answerKeyCorrect: true, inScope: false, note: 'needs limits' };

function call(modelId: string, durationMs: number, outcome: CompareCallRecord['outcome'] = 'ok'): CompareCallRecord {
  return { agent: 'conceptBankAuthor', modelId, durationMs, outcome, inputTokens: 1_000_000, outputTokens: 0, webSearchQueries: 0 };
}

const bank = (over: Partial<BankInputResult>): BankInputResult => ({
  authored: 5,
  kept: 5,
  authorCalls: [call(PRO_MODEL_ID, 20_000)],
  grades: [ok, ok, ok, ok, ok],
  rateLimited: 0,
  ...over,
});

const metrics = (over: Partial<BankRunMetrics>): BankRunMetrics => ({
  banks: 15,
  errors: 0,
  ungradedBanks: 0,
  authored: 75,
  kept: 72,
  keptRate: 0.96,
  gradedQuestions: 72,
  keyErrorRate: 0.02,
  outOfScopeRate: 0.1,
  p50LatencyMs: 25_000,
  maxLatencyMs: 35_000,
  failedAttempts: 0,
  rateLimited: 0,
  usdPerBank: { pro: 0.05, flashIntro: null, flash2027: null },
  ...over,
});

describe('parseGrades', () => {
  const grade = (question: number, g: QuestionGrade = ok) => ({ question, ...g });

  it('returns grades in question order', () => {
    const parsed = parseGrades({ grades: [grade(2, wrongKey), grade(1)] }, 2);
    expect(parsed).toEqual({ ok: true, grades: [ok, wrongKey] });
  });

  it('rejects a response that fails the schema', () => {
    expect(parseGrades({ grades: [{ question: 1, answerKeyCorrect: 'yes' }] }, 1).ok).toBe(false);
    expect(parseGrades('not json', 1).ok).toBe(false);
  });

  it('rejects a skipped, duplicated or out-of-range question rather than scoring it', () => {
    expect(parseGrades({ grades: [grade(1)] }, 2)).toEqual({ ok: false, reason: 'question 2 not graded' });
    expect(parseGrades({ grades: [grade(1), grade(1)] }, 2).ok).toBe(false);
    expect(parseGrades({ grades: [grade(1), grade(3)] }, 2).ok).toBe(false);
  });
});

describe('buildGraderPrompt', () => {
  it('carries the concept, resources and every question, and nothing that names an arm or model', () => {
    const prompt = buildGraderPrompt({
      topic: 'calculus',
      conceptTitle: 'Limits',
      resources: [{ title: 'Limits intro', type: 'video' }],
      questions: [question(1), question(2)],
    });
    expect(prompt).toContain('Concept: Limits');
    expect(prompt).toContain('- Limits intro (video)');
    expect(prompt).toContain('### Question 2 (mcq)');
    expect(prompt).not.toMatch(ARM_OR_MODEL);
    expect(GRADER_SYSTEM_PROMPT).not.toMatch(ARM_OR_MODEL);
  });
});

describe('count429s', () => {
  const apiError = (statusCode: number) =>
    new APICallError({ message: statusCode === 429 ? 'Resource exhausted' : 'Bad gateway', url: 'u', requestBodyValues: {}, statusCode });

  it('counts each 429 attempt inside a RetryError', () => {
    const err = new RetryError({ message: 'failed', reason: 'maxRetriesExceeded', errors: [apiError(429), apiError(502), apiError(429)] });
    expect(count429s(err)).toBe(2);
  });

  it('counts a bare 429 and ignores other errors', () => {
    expect(count429s(apiError(429))).toBe(1);
    expect(count429s(apiError(500))).toBe(0);
    expect(count429s(new Error('timeout'))).toBe(0);
  });
});

describe('summarizeBanks', () => {
  it('computes rates over graded questions only, excluding ungraded banks', () => {
    const m = summarizeBanks([
      bank({ grades: [ok, wrongKey, outOfScope, ok, ok] }),
      bank({ grades: null }),
      bank({ authored: 6, kept: 4, grades: [ok, ok, ok, ok] }),
    ]);
    expect(m.ungradedBanks).toBe(1);
    expect(m.gradedQuestions).toBe(9);
    expect(m.keyErrorRate).toBeCloseTo(1 / 9);
    expect(m.outOfScopeRate).toBeCloseTo(1 / 9);
    expect(m.kept).toBe(14);
    expect(m.authored).toBe(16);
  });

  it('takes latency from ok attempts only, counts failed attempts and confirmed 429s', () => {
    const m = summarizeBanks([
      bank({ authorCalls: [call(FLASH_MODEL_ID, 300, 'error'), call(FLASH_MODEL_ID, 8_000)] }),
      bank({ authorCalls: [call(FLASH_MODEL_ID, 12_000)] }),
      bank({ authored: 0, kept: 0, authorCalls: [], grades: [], rateLimited: 3, error: 'Resource exhausted' }),
    ]);
    expect(m.p50LatencyMs).toBe(10_000);
    expect(m.maxLatencyMs).toBe(12_000);
    expect(m.failedAttempts).toBe(1);
    expect(m.rateLimited).toBe(3);
    expect(m.errors).toBe(1);
    expect(m.ungradedBanks).toBe(0);
  });

  it('prices a bank at each price point from its own model', () => {
    const pro = summarizeBanks([bank({}), bank({})]);
    expect(pro.usdPerBank).toEqual({ pro: 2, flashIntro: null, flash2027: null });
    const flash = summarizeBanks([bank({ authorCalls: [call(FLASH_MODEL_ID, 1)] })]);
    expect(flash.usdPerBank).toEqual({ pro: null, flashIntro: 0.75, flash2027: 1.5 });
  });
});

describe('bankBars', () => {
  it('passes an arm that clears every bar', () => {
    const { verdict, bars } = bankBars(metrics({ keyErrorRate: 0.01, p50LatencyMs: 10_000 }), metrics({}));
    expect(bars.every((b) => b.pass)).toBe(true);
    expect(verdict).toBe('PASS');
  });

  it('caps the key-error bar at 3% even when the baseline is worse', () => {
    const { bars, verdict } = bankBars(metrics({ keyErrorRate: 0.04, p50LatencyMs: 10_000 }), metrics({ keyErrorRate: 0.05 }));
    expect(bars[0].threshold).toBe(0.03);
    expect(verdict).toBe('FAIL');
  });

  it('fails on scope, kept rate or latency at their thresholds', () => {
    const base = metrics({});
    expect(bankBars(metrics({ outOfScopeRate: 0.16, p50LatencyMs: 10_000 }), base).verdict).toBe('FAIL');
    expect(bankBars(metrics({ keptRate: 0.9, p50LatencyMs: 10_000 }), base).verdict).toBe('FAIL');
    expect(bankBars(metrics({ p50LatencyMs: 16_000 }), base).verdict).toBe('FAIL');
  });

  it('is INCONCLUSIVE when the baseline authored nothing or nothing of it was graded', () => {
    const arm = metrics({ p50LatencyMs: 10_000 });
    expect(bankBars(arm, metrics({ authored: 0, kept: 0, keptRate: null })).verdict).toBe('INCONCLUSIVE');
    expect(bankBars(arm, metrics({ gradedQuestions: 0, keyErrorRate: null, outOfScopeRate: null })).verdict).toBe('INCONCLUSIVE');
  });
});

describe('human read', () => {
  it('holds an automated PASS as PENDING until the read is recorded', () => {
    expect(finalVerdict('PASS', undefined)).toBe('PENDING HUMAN READ');
    expect(finalVerdict('PASS', 'pass')).toBe('PASS');
    expect(finalVerdict('PASS', 'fail')).toBe('FAIL');
    expect(finalVerdict('FAIL', 'pass')).toBe('FAIL');
    expect(finalVerdict('INCONCLUSIVE', undefined)).toBe('INCONCLUSIVE');
  });

  it('parses --human-read', () => {
    expect(parseHumanRead(['--smoke'])).toBeUndefined();
    expect(parseHumanRead(['--human-read=fail'])).toBe('fail');
    expect(() => parseHumanRead(['--human-read'])).toThrow();
    expect(() => parseHumanRead(['--human-read=maybe'])).toThrow();
  });

  it('reads back the last completed run, ignoring an unfinished later one', () => {
    const verdict = (runId: string, arm: string) => ({ kind: 'verdict', runId, arm, verdict: 'PASS', bars: [], metrics: metrics({}), baseline: metrics({}) });
    const rows: unknown[] = [
      { kind: 'run-start', runId: 'a' },
      verdict('a', 'flash-low'),
      { kind: 'run-end', runId: 'a', candidate: null },
      { kind: 'run-start', runId: 'b' },
      { kind: 'bank', runId: 'b' },
      verdict('b', 'flash-low'),
      verdict('b', 'flash-default'),
      { kind: 'run-end', runId: 'b', candidate: 'flash-default' },
      { kind: 'run-start', runId: 'c' },
      verdict('c', 'flash-low'),
    ];
    const run = lastCompletedRun(rows);
    expect(run?.runId).toBe('b');
    expect(run?.candidate).toBe('flash-default');
    expect(run?.verdicts.map((v) => v.arm)).toEqual(['flash-low', 'flash-default']);
    expect(lastCompletedRun([{ kind: 'run-start', runId: 'x' }])).toBeNull();
  });
});

describe('shuffle and blindSample', () => {
  it('shuffles deterministically under a seed and keeps every item', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = shuffle(items, seededRng(7));
    expect(shuffle(items, seededRng(7))).toEqual(a);
    expect(a).not.toEqual(items);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
  });

  const source = (arm: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ conceptId: `${arm}-c${i}`, conceptTitle: `Concept ${i}`, question: question(i) }));

  it('samples perArm per arm, names no arm or model, and keys every id to its arm', () => {
    const { markdown, key } = blindSample(
      [
        { arm: 'baseline', questions: source('baseline', 40) },
        { arm: 'flash-low', questions: source('flash-low', 35) },
      ],
      30,
      seededRng(1),
    );
    const ids = Object.keys(key);
    expect(ids).toHaveLength(60);
    expect(Object.values(key).filter((k) => k.arm === 'baseline')).toHaveLength(30);
    for (const id of ids) {
      expect(markdown).toContain(`## ${id} ·`);
      expect(key[id].conceptId.startsWith(key[id].arm)).toBe(true);
    }
    expect(markdown).not.toMatch(ARM_OR_MODEL);
  });

  it('interleaves the arms rather than listing one after the other', () => {
    const { key } = blindSample(
      [
        { arm: 'baseline', questions: source('baseline', 30) },
        { arm: 'pro-low', questions: source('pro-low', 30) },
      ],
      30,
      seededRng(3),
    );
    const arms = Object.values(key).map((k) => k.arm);
    expect(arms.slice(0, 30).every((a) => a === 'baseline')).toBe(false);
  });

  it('takes every question of an arm that has fewer than perArm', () => {
    const { key } = blindSample([{ arm: 'baseline', questions: source('baseline', 4) }], 30, seededRng(2));
    expect(Object.keys(key)).toHaveLength(4);
  });
});
