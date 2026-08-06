// Reports R5: track regeneration — the learner-facing repair action that collects
// the fixes reports produced.
//
// Built Tracks are IMMUTABLE snapshots (see pending-review.ts), so "fix my course"
// can only mean "build a new one and repoint the slot". Nothing here mutates a
// Track. The whole effect is one extra CourseRequest with the same (programId,
// topic) and `replacesTrackId` set: the unchanged per-topic worker builds it, and
// maybeAssembleProgram already repoints ProgramPath.trackId via
// updateMany({ where: { programId, topic } }) once every sibling is terminal — and
// its status guard no-ops on an already-`ready` Program. So this block adds NO build
// machinery; it is preconditions, metering, and an insert.
//
// The four preconditions are deliberately distinct refusals rather than one boolean:
// each is a different thing the learner can do about it, and R7 explains them by name.

import { CourseRequestStatus, ResourceStatus, type Difficulty } from '@prisma/client';
import { prisma } from '@/lib/db';
import { log, logWarn } from '@/lib/log';
import { findRecentRebuild, rebuildQuota } from '@/lib/services/rebuild-limits';

// The learner's edits to the Track's inputs. Any field left undefined is cloned from
// the Track being replaced; a present field both overrides AND satisfies precondition
// 4 (an input change always makes the rebuild meaningfully different, even off an
// identical resource pool).
export type RebuildOverrides = {
  priorKnowledge?: string | null;
  goal?: string | null;
  timeframeWeeks?: number;
  hoursPerWeek?: number;
  targetMastery?: Difficulty;
};

export type RegenerateResult =
  | { ok: true; requestId: string; topic: string; deduplicated: boolean }
  | { ok: false; refusal: 'not_found' | 'not_enrolled' | 'already_rebuilding' }
  | { ok: false; refusal: 'quota_exceeded'; quota: { used: number; limit: number } }
  | { ok: false; refusal: 'not_stale'; staleness: TrackStaleness };

// ---------------------------------------------------------------------------
// Precondition 4, as a pure function so it is testable without a DB.
// ---------------------------------------------------------------------------

export type StalenessInput = {
  trackCreatedAt: Date;
  // Every Resource reachable from the Track's lessons (LessonResource set).
  resources: { status: ResourceStatus; updatedAt: Date }[];
  // Proxy for "the Path's readiness changed": a readiness flip writes Path.status,
  // which bumps @updatedAt. Cheaper and more honest than reconstructing what the
  // readiness WAS at build time, which we don't record.
  pathUpdatedAt: Date;
  // Concepts on the Track's Path created or touched since the build — the concept
  // set moving is exactly what makes a re-compose produce a different course.
  conceptsChangedSince: number;
  inputsEdited: boolean;
};

// Counts, not just a boolean: R7 states plainly WHAT changed ("3 resources were
// removed as broken since this course was built"), and a bare `stale: true` can't.
export type TrackStaleness = {
  stale: boolean;
  deprecatedResources: number;
  changedResources: number;
  pathChanged: boolean;
  conceptsChanged: number;
  inputsEdited: boolean;
};

export function assessStaleness(input: StalenessInput): TrackStaleness {
  // Non-active covers `deprecated` AND `pending_review`: both mean the resource is
  // no longer something we would seat in a fresh build, which is the question here.
  const deprecatedResources = input.resources.filter((r) => r.status !== ResourceStatus.active).length;
  // Overlaps with the count above by design (a deprecation also bumps updatedAt) —
  // the two answer different learner-facing questions: "removed as broken" vs
  // "corrected since" (a duration fix, a re-embed, a refile).
  const changedResources = input.resources.filter((r) => r.updatedAt > input.trackCreatedAt).length;
  const pathChanged = input.pathUpdatedAt > input.trackCreatedAt;
  const stale =
    input.inputsEdited ||
    deprecatedResources > 0 ||
    changedResources > 0 ||
    pathChanged ||
    input.conceptsChangedSince > 0;
  return {
    stale,
    deprecatedResources,
    changedResources,
    pathChanged,
    conceptsChanged: input.conceptsChangedSince,
    inputsEdited: input.inputsEdited,
  };
}

// The Track's own inputs, as the DB holds them (nullable, never undefined) — the
// baseline `overrides` are compared against and cloned from.
export type TrackInputs = {
  priorKnowledge: string | null;
  goal: string | null;
  timeframeWeeks: number | null;
  hoursPerWeek: number | null;
  targetMastery: Difficulty | null;
};

// Pure: which of the learner's edits actually differ from what the Track was built
// with. An "edit" that resubmits the same value must NOT satisfy precondition 4 —
// otherwise R7's pre-filled form turns every refusal into a one-click bypass.
export function effectiveEdits(
  track: TrackInputs,
  overrides: RebuildOverrides,
): (keyof RebuildOverrides)[] {
  const keys: (keyof RebuildOverrides)[] = [
    'priorKnowledge',
    'goal',
    'timeframeWeeks',
    'hoursPerWeek',
    'targetMastery',
  ];
  return keys.filter((k) => overrides[k] !== undefined && overrides[k] !== track[k]);
}

// ---------------------------------------------------------------------------

export type RegenerateInput = {
  userId: string;
  programId: string;
  trackId: string;
  overrides?: RebuildOverrides;
};

export async function regenerateTrack(input: RegenerateInput): Promise<RegenerateResult> {
  const { userId, programId, trackId } = input;
  const overrides = input.overrides ?? {};

  // 1. Ownership. The slot lookup and the enrollment check are separate refusals:
  // an unknown (programId, trackId) pair is a 404, while a real slot the caller
  // isn't enrolled in is a 403 — collapsing them would let a caller probe which
  // Tracks exist.
  const slot = await prisma.programPath.findFirst({
    where: { programId, trackId },
    select: {
      topic: true,
      track: {
        select: {
          createdAt: true,
          pathId: true,
          priorKnowledge: true,
          goal: true,
          timeframeWeeks: true,
          hoursPerWeek: true,
          targetMastery: true,
          path: { select: { updatedAt: true } },
        },
      },
    },
  });
  if (!slot?.track) return { ok: false, refusal: 'not_found' };
  const { topic, track } = slot;

  const enrollment = await prisma.enrolledProgram.findUnique({
    where: { userId_programId: { userId, programId } },
    select: { userId: true },
  });
  if (!enrollment) return { ok: false, refusal: 'not_enrolled' };

  // Duplicate submit — checked before the in-flight refusal below, not after it (see
  // findRecentRebuild): the caller's OWN in-flight rebuild is the double-click case,
  // and it deserves a 202 carrying the request already doing the work rather than a
  // 409 that reads as "you can't do that". Checked before the quota too, like
  // generate-program: a resubmit should return existing work even at the limit.
  const duplicate = await findRecentRebuild(userId, programId, topic);
  if (duplicate) {
    log('regenerate-track.deduplicated', { userId, programId, topic, requestId: duplicate.id });
    return { ok: true, requestId: duplicate.id, topic, deduplicated: true };
  }

  // 2. Single in-flight. Scoped to the SLOT, not the caller — with the caller's own
  // rebuild already handled above, what remains is SOMEONE ELSE's in-flight rebuild
  // of a shared slot, which must refuse: it would produce one Track and make one of
  // the two learners silently pay for the other's build. Checked here (before the
  // staleness reads) so the refusal is cheap; re-checked inside the transaction
  // below, which is the authoritative one.
  const inFlight = await prisma.courseRequest.count({
    where: {
      programId,
      topic,
      status: { in: [CourseRequestStatus.queued, CourseRequestStatus.running] },
    },
  });
  if (inFlight > 0) return { ok: false, refusal: 'already_rebuilding' };

  // 3. Quota.
  const quota = await rebuildQuota(userId);
  if (!quota.allowed) {
    return { ok: false, refusal: 'quota_exceeded', quota: { used: quota.used, limit: quota.limit } };
  }

  // 4. Staleness. A rebuild off an identical pool is a coin flip that costs a real
  // build, so it is refused — unless the learner changed what they're asking for.
  const edits = effectiveEdits(track, overrides);
  const [links, conceptsChangedSince] = await Promise.all([
    prisma.lessonResource.findMany({
      where: { lesson: { trackId } },
      select: { resource: { select: { status: true, updatedAt: true } } },
    }),
    prisma.concept.count({ where: { pathId: track.pathId, updatedAt: { gt: track.createdAt } } }),
  ]);
  const staleness = assessStaleness({
    trackCreatedAt: track.createdAt,
    resources: links.map((l) => l.resource),
    pathUpdatedAt: track.path.updatedAt,
    conceptsChangedSince,
    inputsEdited: edits.length > 0,
  });
  if (!staleness.stale) return { ok: false, refusal: 'not_stale', staleness };

  // Effect. The transaction re-checks precondition 2 immediately before the insert,
  // which is what makes concurrent submits cost at most one wasted build rather than
  // two Tracks racing for one slot. It is deliberately NOT airtight: the alternative
  // is a partial unique index, a third permanent hand-maintained index (AGENTS.md) —
  // and the failure mode here is spend, not corruption.
  const created = await prisma.$transaction(async (tx) => {
    const racing = await tx.courseRequest.count({
      where: {
        programId,
        topic,
        status: { in: [CourseRequestStatus.queued, CourseRequestStatus.running] },
      },
    });
    if (racing > 0) return null;
    return tx.courseRequest.create({
      data: {
        topic,
        programId,
        userId,
        replacesTrackId: trackId,
        priorKnowledge: overrides.priorKnowledge ?? track.priorKnowledge,
        goal: overrides.goal ?? track.goal,
        timeframeWeeks: overrides.timeframeWeeks ?? track.timeframeWeeks,
        hoursPerWeek: overrides.hoursPerWeek ?? track.hoursPerWeek,
        targetMastery: overrides.targetMastery ?? track.targetMastery,
      },
      select: { id: true },
    });
  });
  if (!created) {
    logWarn('regenerate-track.raced', { userId, programId, topic });
    return { ok: false, refusal: 'already_rebuilding' };
  }

  log('regenerate-track.enqueued', {
    userId,
    programId,
    topic,
    requestId: created.id,
    replacesTrackId: trackId,
    edits,
    deprecatedResources: staleness.deprecatedResources,
  });
  return { ok: true, requestId: created.id, topic, deduplicated: false };
}
