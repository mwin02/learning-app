import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// report-intake imports @/lib/db (throws at module eval without DATABASE_URL).
const lessonResourceFindUnique = vi.fn();
const lessonFindUnique = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    lessonResource: { findUnique: (...a: unknown[]) => lessonResourceFindUnique(...a) },
    lesson: { findUnique: (...a: unknown[]) => lessonFindUnique(...a) },
  },
}));

import { planReopen, resolveLessonContext } from '@/lib/services/report-intake';

function lastWarn(warn: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = warn.mock.calls.at(-1);
  if (!call) throw new Error('nothing was logged');
  return JSON.parse(String(call[0]));
}

describe('resolveLessonContext', () => {
  beforeEach(() => {
    lessonResourceFindUnique.mockReset();
    lessonFindUnique.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps a lesson that actually contains the resource', async () => {
    lessonResourceFindUnique.mockResolvedValue({ lessonId: 'l1' });
    expect(await resolveLessonContext('r1', 'l1')).toBe('l1');
    expect(lessonResourceFindUnique).toHaveBeenCalledWith({
      where: { lessonId_resourceId: { lessonId: 'l1', resourceId: 'r1' } },
      select: { lessonId: true },
    });
    expect(lessonFindUnique).not.toHaveBeenCalled();
  });

  it('drops a real lesson that never contained the resource, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    lessonResourceFindUnique.mockResolvedValue(null);
    lessonFindUnique.mockResolvedValue({ id: 'l1' });
    expect(await resolveLessonContext('r1', 'l1')).toBeNull();
    expect(lastWarn(warn)).toMatchObject({
      event: 'report.unrelated_lesson',
      resourceId: 'r1',
      lessonId: 'l1',
    });
  });

  it('drops an unknown lesson id, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    lessonResourceFindUnique.mockResolvedValue(null);
    lessonFindUnique.mockResolvedValue(null);
    expect(await resolveLessonContext('r1', 'nope')).toBeNull();
    expect(lastWarn(warn)).toMatchObject({
      event: 'report.unknown_lesson',
      resourceId: 'r1',
      lessonId: 'nope',
    });
  });
});

describe('planReopen', () => {
  const noEvidence = { lessonId: null, note: null };

  it('reopens a resolved report and preserves the operator resolution', () => {
    const existing = { resolution: 'swapped the URL', priorResolution: null };
    expect(planReopen(existing, noEvidence)).toEqual({
      state: 'open',
      resolution: null,
      resolvedAt: null,
      priorResolution: 'swapped the URL',
    });
  });

  it('reopens a dismissed report without erasing the dismissal note', () => {
    const note = 'not a defect — the paywall is the publisher\'s';
    const plan = planReopen(
      { resolution: note, priorResolution: null },
      noEvidence
    );
    expect(plan.state).toBe('open');
    expect(plan.priorResolution).toBe(note);
  });

  it('keeps the preserved resolution when an already-open row is reported again', () => {
    const plan = planReopen({ resolution: null, priorResolution: 'http 404' }, noEvidence);
    expect(plan.priorResolution).toBe('http 404');
  });

  it('supersedes the preserved resolution with a newer settled one', () => {
    const plan = planReopen(
      { resolution: 'replaced the video', priorResolution: 'http 404' },
      noEvidence
    );
    expect(plan.priorResolution).toBe('replaced the video');
  });

  it('leaves priorResolution untouched when there is no row to preserve', () => {
    expect(planReopen(null, noEvidence)).toEqual({
      state: 'open',
      resolution: null,
      resolvedAt: null,
    });
  });

  it('writes evidence only when the re-report supplies it', () => {
    expect(planReopen(null, { lessonId: 'l1', note: 'still 404' })).toMatchObject({
      lessonId: 'l1',
      note: 'still 404',
    });
    const bare = planReopen(null, noEvidence);
    expect(bare).not.toHaveProperty('lessonId');
    expect(bare).not.toHaveProperty('note');
  });
});
