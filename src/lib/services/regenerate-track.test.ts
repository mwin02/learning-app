import { describe, expect, it, vi, beforeEach } from 'vitest';

// regenerate-track imports @/lib/db (throws at module eval without DATABASE_URL).
// The stub is a full fake of the queries the service issues, so the precondition
// LADDER — which refusal wins, and in what order — is testable without a DB.
const db = vi.hoisted(() => ({
  programPath: { findFirst: vi.fn() },
  enrolledProgram: { findUnique: vi.fn() },
  courseRequest: { count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  lessonResource: { findMany: vi.fn() },
  concept: { count: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));

import {
  assessStaleness,
  effectiveEdits,
  regenerateTrack,
  type TrackInputs,
} from '@/lib/services/regenerate-track';
import { FREE_TRACK_REBUILDS_PER_MONTH } from '@/lib/config';

const BUILT = new Date('2026-08-01T00:00:00Z');
const BEFORE = new Date('2026-07-01T00:00:00Z');
const AFTER = new Date('2026-08-04T00:00:00Z');

const baseStaleness = {
  trackCreatedAt: BUILT,
  resources: [{ status: 'active' as const, updatedAt: BEFORE }],
  pathUpdatedAt: BEFORE,
  conceptsCreatedSince: 0,
  inputsEdited: false,
};

describe('assessStaleness', () => {
  it('is not stale when nothing moved since the build', () => {
    expect(assessStaleness(baseStaleness)).toEqual({
      stale: false,
      deprecatedResources: 0,
      changedResources: 0,
      pathChanged: false,
      conceptsCreated: 0,
      inputsEdited: false,
    });
  });

  it('is stale when a resource was deprecated — the dead-link report loop', () => {
    const v = assessStaleness({
      ...baseStaleness,
      resources: [
        { status: 'active', updatedAt: BEFORE },
        { status: 'deprecated', updatedAt: AFTER },
      ],
    });
    expect(v.stale).toBe(true);
    expect(v.deprecatedResources).toBe(1);
    // A deprecation bumps updatedAt too — both counts see it, on purpose.
    expect(v.changedResources).toBe(1);
  });

  it('counts pending_review as no-longer-active', () => {
    const v = assessStaleness({
      ...baseStaleness,
      resources: [{ status: 'pending_review', updatedAt: BEFORE }],
    });
    expect(v.deprecatedResources).toBe(1);
    expect(v.stale).toBe(true);
  });

  // R7's tightening. Both mtime proxies are still COUNTED — the dialog's
  // "corrected since" line reads one, the logs read the other — but neither may
  // gate a build on its own any more.
  it('reports a corrected resource without calling the track stale', () => {
    const v = assessStaleness({
      ...baseStaleness,
      resources: [{ status: 'active', updatedAt: AFTER }],
    });
    expect(v).toMatchObject({ stale: false, deprecatedResources: 0, changedResources: 1 });
  });

  it('is NOT stale when the Path row was merely touched', () => {
    // The regression this whole tightening exists to prevent: a readiness flip or
    // a remediation pass bumps Path.updatedAt, and on real data that alone made
    // three of four live tracks offer a rebuild justified by nothing.
    expect(assessStaleness({ ...baseStaleness, pathUpdatedAt: AFTER })).toMatchObject({
      stale: false,
      pathChanged: true,
    });
  });

  it('is stale when a concept was created since the build', () => {
    expect(assessStaleness({ ...baseStaleness, conceptsCreatedSince: 2 })).toMatchObject({
      stale: true,
      conceptsCreated: 2,
    });
  });

  it('still refuses a track where only mtimes moved, everywhere at once', () => {
    expect(
      assessStaleness({
        ...baseStaleness,
        resources: [{ status: 'active', updatedAt: AFTER }],
        pathUpdatedAt: AFTER,
      }).stale
    ).toBe(false);
  });

  it('is stale on an input edit even off an identical pool', () => {
    expect(assessStaleness({ ...baseStaleness, inputsEdited: true }).stale).toBe(true);
  });

  it('treats a resource updated exactly at build time as unchanged (strict >)', () => {
    expect(
      assessStaleness({ ...baseStaleness, resources: [{ status: 'active', updatedAt: BUILT }] }).stale
    ).toBe(false);
  });

  it('is not stale for an empty Track (no resources, nothing moved)', () => {
    expect(assessStaleness({ ...baseStaleness, resources: [] }).stale).toBe(false);
  });
});

describe('effectiveEdits', () => {
  const track: TrackInputs = {
    priorKnowledge: 'some python',
    goal: 'pass the exam',
    timeframeWeeks: 8,
    hoursPerWeek: 5,
    targetMastery: 'beginner',
  };

  it('reports nothing when no override is supplied', () => {
    expect(effectiveEdits(track, {})).toEqual([]);
  });

  it('ignores a resubmitted identical value — a pre-filled form is not an edit', () => {
    expect(effectiveEdits(track, { goal: 'pass the exam', hoursPerWeek: 5 })).toEqual([]);
  });

  it('reports only the fields that actually differ', () => {
    expect(effectiveEdits(track, { goal: 'pass the exam', targetMastery: 'advanced' })).toEqual([
      'targetMastery',
    ]);
  });

  it('treats clearing a value to null as an edit', () => {
    expect(effectiveEdits(track, { priorKnowledge: null })).toEqual(['priorKnowledge']);
  });

  it('treats setting a value the Track never had as an edit', () => {
    expect(effectiveEdits({ ...track, timeframeWeeks: null }, { timeframeWeeks: 8 })).toEqual([
      'timeframeWeeks',
    ]);
  });
});

describe('regenerateTrack preconditions', () => {
  const input = { userId: 'u1', programId: 'p1', trackId: 't1' };
  const slot = {
    topic: 'python-data',
    track: {
      createdAt: BUILT,
      pathId: 'path1',
      priorKnowledge: null,
      goal: 'learn pandas',
      timeframeWeeks: 8,
      hoursPerWeek: 5,
      targetMastery: null,
      path: { updatedAt: BEFORE },
    },
  };

  // The happy path: enrolled, nothing in flight, quota free, one deprecated resource.
  beforeEach(() => {
    for (const fn of [
      db.programPath.findFirst,
      db.enrolledProgram.findUnique,
      db.courseRequest.count,
      db.courseRequest.findFirst,
      db.courseRequest.create,
      db.lessonResource.findMany,
      db.concept.count,
      db.$transaction,
    ]) {
      fn.mockReset();
    }
    db.programPath.findFirst.mockResolvedValue(slot);
    db.enrolledProgram.findUnique.mockResolvedValue({ userId: 'u1' });
    db.courseRequest.count.mockResolvedValue(0);
    db.courseRequest.findFirst.mockResolvedValue(null);
    db.lessonResource.findMany.mockResolvedValue([
      { resource: { status: 'deprecated', updatedAt: AFTER } },
    ]);
    db.concept.count.mockResolvedValue(0);
    db.courseRequest.create.mockResolvedValue({ id: 'req1' });
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  });

  it('enqueues a rebuild carrying replacesTrackId and the cloned inputs', async () => {
    const result = await regenerateTrack(input);
    expect(result).toEqual({ ok: true, requestId: 'req1', topic: 'python-data', deduplicated: false });
    expect(db.courseRequest.create).toHaveBeenCalledWith({
      data: {
        topic: 'python-data',
        programId: 'p1',
        userId: 'u1',
        replacesTrackId: 't1',
        priorKnowledge: null,
        goal: 'learn pandas',
        timeframeWeeks: 8,
        hoursPerWeek: 5,
        targetMastery: null,
      },
      select: { id: true },
    });
  });

  it("applies the learner's overrides over the Track's inputs", async () => {
    await regenerateTrack({ ...input, overrides: { hoursPerWeek: 10, targetMastery: 'advanced' } });
    expect(db.courseRequest.create.mock.calls[0][0].data).toMatchObject({
      hoursPerWeek: 10,
      targetMastery: 'advanced',
      goal: 'learn pandas',
    });
  });

  // The bug this block exists for: `??` fell back to the Track's value for exactly
  // `null`, so clearing a field satisfied precondition 4, spent a rebuild from the
  // monthly quota, and enqueued a build with byte-identical inputs — repeatable
  // until the quota was gone. Asserted on the `create` data, which is the only
  // place the discard was visible.
  it('writes a cleared goal as NULL rather than re-cloning the Track value', async () => {
    await regenerateTrack({ ...input, overrides: { goal: null } });
    expect(db.courseRequest.create.mock.calls[0][0].data).toMatchObject({ goal: null });
  });

  it('writes a cleared priorKnowledge as NULL', async () => {
    db.programPath.findFirst.mockResolvedValue({
      ...slot,
      track: { ...slot.track, priorKnowledge: 'some python' },
    });
    await regenerateTrack({ ...input, overrides: { priorKnowledge: null } });
    expect(db.courseRequest.create.mock.calls[0][0].data).toMatchObject({ priorKnowledge: null });
  });

  // A clear must never be the free bypass: on a track that is otherwise not stale,
  // it either applies (an edit) or is refused — never spent on identical inputs.
  it('spends a rebuild on a not-stale track only when the clear is a real change', async () => {
    db.lessonResource.findMany.mockResolvedValue([
      { resource: { status: 'active', updatedAt: BEFORE } },
    ]);
    const applied = await regenerateTrack({ ...input, overrides: { goal: null } });
    expect(applied).toMatchObject({ ok: true });
    expect(db.courseRequest.create.mock.calls[0][0].data).toMatchObject({ goal: null });

    db.courseRequest.create.mockClear();
    // The Track's goal is already null here, so clearing it changes nothing.
    db.programPath.findFirst.mockResolvedValue({ ...slot, track: { ...slot.track, goal: null } });
    expect(await regenerateTrack({ ...input, overrides: { goal: null } })).toMatchObject({
      ok: false,
      refusal: 'not_stale',
    });
    expect(db.courseRequest.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown slot before touching enrollment', async () => {
    db.programPath.findFirst.mockResolvedValue(null);
    expect(await regenerateTrack(input)).toEqual({ ok: false, refusal: 'not_found' });
    expect(db.enrolledProgram.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a slot whose Track was cleaned up', async () => {
    db.programPath.findFirst.mockResolvedValue({ topic: 'python-data', track: null });
    expect(await regenerateTrack(input)).toEqual({ ok: false, refusal: 'not_found' });
  });

  it('refuses a caller who is not enrolled', async () => {
    db.enrolledProgram.findUnique.mockResolvedValue(null);
    expect(await regenerateTrack(input)).toEqual({ ok: false, refusal: 'not_enrolled' });
  });

  it("refuses when SOMEONE ELSE's build for this slot is in flight, before spending on staleness", async () => {
    db.courseRequest.count.mockResolvedValue(1);
    expect(await regenerateTrack(input)).toEqual({ ok: false, refusal: 'already_rebuilding' });
    expect(db.lessonResource.findMany).not.toHaveBeenCalled();
  });

  it("returns the caller's own in-flight rebuild as a 202 rather than a new build", async () => {
    db.courseRequest.findFirst.mockResolvedValue({ id: 'earlier', status: 'running' });
    expect(await regenerateTrack(input)).toEqual({
      ok: true,
      requestId: 'earlier',
      topic: 'python-data',
      deduplicated: true,
    });
    expect(db.courseRequest.create).not.toHaveBeenCalled();
  });

  // The regression the dedup window used to cause: rebuild → build lands → learner
  // reports more defects → rebuilds again. findRecentRebuild filters on
  // queued/running, so a fulfilled predecessor cannot match and this must proceed to
  // a real build. Pinned here as well as in rebuild-limits.test.ts because it is the
  // feature's primary loop, not a limiter detail.
  it('does not dedup against a FULFILLED recent rebuild — it enqueues a fresh one', async () => {
    db.courseRequest.findFirst.mockResolvedValue(null);
    const result = await regenerateTrack(input);
    expect(result).toEqual({
      ok: true,
      requestId: 'req1',
      topic: 'python-data',
      deduplicated: false,
    });
    expect(db.courseRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['queued', 'running'] } }),
      }),
    );
  });

  it('refuses when the monthly rebuild quota is spent', async () => {
    // First count() is the in-flight check, second is rebuildQuota's.
    db.courseRequest.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(FREE_TRACK_REBUILDS_PER_MONTH);
    const result = await regenerateTrack(input);
    expect(result).toEqual({
      ok: false,
      refusal: 'quota_exceeded',
      quota: { used: FREE_TRACK_REBUILDS_PER_MONTH, limit: FREE_TRACK_REBUILDS_PER_MONTH },
    });
  });

  it('refuses when nothing changed since the build', async () => {
    db.lessonResource.findMany.mockResolvedValue([
      { resource: { status: 'active', updatedAt: BEFORE } },
    ]);
    const result = await regenerateTrack(input);
    expect(result).toMatchObject({ ok: false, refusal: 'not_stale' });
    expect(db.courseRequest.create).not.toHaveBeenCalled();
  });

  it('counts only concepts CREATED since the build, not merely touched ones', async () => {
    await regenerateTrack(input);
    expect(db.concept.count).toHaveBeenCalledWith({
      where: { pathId: 'path1', createdAt: { gt: BUILT } },
    });
  });

  it('allows a rebuild off an unchanged pool when the learner edited their inputs', async () => {
    db.lessonResource.findMany.mockResolvedValue([
      { resource: { status: 'active', updatedAt: BEFORE } },
    ]);
    const result = await regenerateTrack({ ...input, overrides: { hoursPerWeek: 12 } });
    expect(result).toMatchObject({ ok: true, requestId: 'req1' });
  });

  it('refuses when the in-transaction re-check finds a racing rebuild', async () => {
    // In-flight check passes, quota check passes, then the transactional re-check
    // sees a request another submit inserted in the meantime.
    db.courseRequest.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    expect(await regenerateTrack(input)).toEqual({ ok: false, refusal: 'already_rebuilding' });
    expect(db.courseRequest.create).not.toHaveBeenCalled();
  });
});
