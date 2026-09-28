import { describe, it, expect, vi, beforeEach } from 'vitest';

// generate-concept-bank imports @/lib/db and (via author-concept-bank) the model
// registry — both validate env at module-eval. Stub the leaves; the backfill tests
// drive the real generateConceptBank against these stubs, so the stamp write
// (concept.update) and the author call are observable.
const db = vi.hoisted(() => ({
  concept: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));
const author = vi.hoisted(() => ({ authorConceptBank: vi.fn() }));
const logs = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));
vi.mock('@/lib/agents/content/author-concept-bank', () => author);
vi.mock('@/lib/log', () => logs);

import {
  backfillConceptBanks,
  bankBackfillBudgetMs,
  isBankAttemptCooling,
} from '@/lib/agents/content/generate-concept-bank';
import {
  BANK_BACKFILL_TAIL_RESERVE_MS,
  CONCEPT_BANK_ATTEMPT_COOLDOWN_MS,
  COURSE_JOB_DEADLINE_MS,
} from '@/lib/config';

const NOW = new Date('2026-07-17T12:00:00Z');

describe('isBankAttemptCooling', () => {
  it('is not cooling when never attempted (null stamp)', () => {
    expect(isBankAttemptCooling(null, NOW)).toBe(false);
  });

  it('is cooling for an attempt inside the cool-down', () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000);
    expect(isBankAttemptCooling(recent, NOW)).toBe(true);
  });

  it('is cooling just inside the boundary', () => {
    const fresh = new Date(NOW.getTime() - CONCEPT_BANK_ATTEMPT_COOLDOWN_MS + 1);
    expect(isBankAttemptCooling(fresh, NOW)).toBe(true);
  });

  it('stops cooling exactly at the cool-down age', () => {
    const aged = new Date(NOW.getTime() - CONCEPT_BANK_ATTEMPT_COOLDOWN_MS);
    expect(isBankAttemptCooling(aged, NOW)).toBe(false);
  });
});

const MIN = 60 * 1000;

describe('bankBackfillBudgetMs', () => {
  const start = NOW.getTime();

  it('is what is left of the deadline after the reserve, from job start', () => {
    expect(bankBackfillBudgetMs(start, start + 10 * MIN, 30 * MIN, 5 * MIN)).toBe(15 * MIN);
  });

  it('is spent (≤ 0) once the job is inside the reserve', () => {
    expect(bankBackfillBudgetMs(start, start + 26 * MIN, 30 * MIN, 5 * MIN)).toBeLessThanOrEqual(0);
  });

  it('defaults to the configured deadline and reserve, which leave the backfill a positive budget', () => {
    expect(bankBackfillBudgetMs(start, start)).toBe(COURSE_JOB_DEADLINE_MS - BANK_BACKFILL_TAIL_RESERVE_MS);
    expect(BANK_BACKFILL_TAIL_RESERVE_MS).toBeLessThan(COURSE_JOB_DEADLINE_MS);
  });
});

describe('backfillConceptBanks budget', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const QUESTION = { prompt: 'p', answer: 'a', rubric: 'r', kind: 'recall' };

  // An author that rejects with the signal's reason once its signal aborts.
  const observingAuthor = (ms: number) => (args: { abortSignal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve([QUESTION]), ms);
      args.abortSignal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(args.abortSignal?.reason);
      });
    });

  beforeEach(() => {
    vi.clearAllMocks();
    db.concept.findMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, slug: `s${i}`, bankAttemptedAt: null })),
    );
    db.concept.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id,
        slug: where.id,
        title: where.id,
        isOnRamp: false,
        path: { topic: 't' },
        _count: { questions: 0 },
        resources: [],
      }),
    );
    db.concept.update.mockResolvedValue({});
    db.$transaction.mockResolvedValue(1);
  });

  it('stops after the chunk in which the budget ran out, and returns normally', async () => {
    // A non-observing author: the first chunk completes although the budget expires mid-chunk.
    author.authorConceptBank.mockImplementation(async () => {
      await sleep(40);
      return [QUESTION];
    });
    const res = await backfillConceptBanks({ pathId: 'p', budgetMs: 10 });
    expect(author.authorConceptBank).toHaveBeenCalledTimes(4);
    expect(res).toMatchObject({ candidates: 6, generated: 4, failed: 0, notReached: 2 });
  });

  it('aborts in-flight calls at the budget without stamping or logging them as rejected', async () => {
    author.authorConceptBank.mockImplementation(observingAuthor(5_000));
    const job = new AbortController();
    const res = await backfillConceptBanks({ pathId: 'p', abortSignal: job.signal, budgetMs: 20 });
    expect(author.authorConceptBank).toHaveBeenCalledTimes(4);
    for (const [args] of author.authorConceptBank.mock.calls) expect(args.abortSignal.aborted).toBe(true);
    expect(job.signal.aborted).toBe(false);
    expect(res).toMatchObject({ generated: 0, failed: 0, notReached: 6 });
    expect(db.concept.update).not.toHaveBeenCalled();
    expect(logs.logError).not.toHaveBeenCalled();
  });

  it('a job-signal abort still rejects the backfill, not a budget stop', async () => {
    author.authorConceptBank.mockImplementation(observingAuthor(5_000));
    const job = new AbortController();
    setTimeout(() => job.abort(new Error('job deadline exceeded')), 20);
    await expect(
      backfillConceptBanks({ pathId: 'p', abortSignal: job.signal, budgetMs: 60_000 }),
    ).rejects.toThrow('job deadline exceeded');
    expect(author.authorConceptBank).toHaveBeenCalledTimes(4);
    expect(db.concept.update).not.toHaveBeenCalled();
    expect(logs.logError).toHaveBeenCalledTimes(4);
  });

  it('a stamp write straddling the budget counts the concept failed, never not-reached', async () => {
    db.concept.findMany.mockResolvedValue([{ id: 'c0', slug: 's0', bankAttemptedAt: null }]);
    // The author fails on its own before the budget; the budget fires mid-stamp.
    author.authorConceptBank.mockImplementation(async () => {
      await sleep(2);
      throw new Error('author boom');
    });
    db.concept.update.mockImplementation(async () => {
      await sleep(30);
      return {};
    });
    const res = await backfillConceptBanks({ pathId: 'p', budgetMs: 10 });
    expect(db.concept.update).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ failed: 1, notReached: 0 });
    expect(logs.logError).toHaveBeenCalledTimes(1);
  });

  it('with no budget, runs every chunk', async () => {
    author.authorConceptBank.mockResolvedValue([QUESTION]);
    const res = await backfillConceptBanks({ pathId: 'p' });
    expect(author.authorConceptBank).toHaveBeenCalledTimes(6);
    expect(res).toMatchObject({ generated: 6, notReached: 0 });
  });
});
