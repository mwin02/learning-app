// Phase 2.75c: the Program service — fan-out (enqueueProgram) + the worker's
// post-fulfill assembler (maybeAssembleProgram). This is where a Program rides the
// EXISTING CourseRequest queue: the synchronous plan pass fans its topics out as
// child requests (programId set), the unchanged per-topic worker builds each, and
// the assembler finalizes the Program once every child is terminal.
//
// enqueueProgram owns the whole synchronous pass and persists a `planning` Program
// BEFORE the fallible plan call, so a failed decomposition leaves an auditable
// `failed` row rather than a silent 500 (on-brand with the queue's durable-audit
// philosophy). Only the builds are async.

import { ProgramStatus, CourseRequestStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { log, logError, logWarn, traceUsageSnapshot } from '@/lib/log';
import { planProgram, type ProgramPlan, type ProgramPlanInput } from '@/lib/agents/program/plan';
import { planCarryOver } from '@/lib/services/carry-over-progress';

// inputHash: the H1 idempotency fingerprint (programInputHash), persisted on the
// anchor row so findRecentDuplicate can match a resubmit. Null for operator/dev
// creations that skip the metered path.
export type EnqueueProgramInput = ProgramPlanInput & {
  userId?: string | null;
  inputHash?: string | null;
};

export type EnqueueProgramResult = {
  programId: string;
  status: ProgramStatus;
  topicCount: number;
  // Set only when status=failed — the client-facing diagnostic. Safe to echo to the
  // caller for failureKind 'plan_empty' and 'goal_rejected' (both fixed, non-sensitive
  // messages); the 'internal' message is a raw exception string and must not leave the
  // server, and the goal gate's model-written reason is logged/persisted, never echoed.
  error?: string;
  // Why the plan failed, so the HTTP boundary can pick the right status class:
  //   'goal_rejected' — the goal is off-domain / nonsense (Stage-0 gate) → 422.
  //   'plan_empty'    — goal accepted, but no in-domain topic survived → 422.
  //   'internal'      — an LLM/DB exception during plan or fan-out → 500 (generic).
  failureKind?: 'goal_rejected' | 'plan_empty' | 'internal';
};

// Create Program(planning) → plan → fan out child requests + plan slots → building.
// `plan` is injectable so the DB fan-out + assembler can be fixture-tested without
// an LLM. Never throws: a plan failure is recorded on the Program as `failed`.
export async function enqueueProgram(
  input: EnqueueProgramInput,
  opts: { plan?: (input: ProgramPlanInput) => Promise<ProgramPlan> } = {},
): Promise<EnqueueProgramResult> {
  const plan = opts.plan ?? ((i: ProgramPlanInput) => planProgram(i));

  // Durable anchor before the fallible plan pass. Phase 3c: the creator is
  // auto-enrolled HERE (nested create, same insert) rather than at assembly, so
  // the dashboard sees in-flight — even failed — Programs through the same
  // enrollment lens as finished ones. Enrollment is free; creation is what the
  // route meters (programQuota).
  const program = await prisma.program.create({
    data: {
      goal: input.goal,
      background: input.background ?? null,
      totalHoursPerWeek: input.totalHoursPerWeek,
      totalWeeks: input.totalWeeks,
      antiList: input.antiList ?? [],
      status: ProgramStatus.planning,
      userId: input.userId ?? null,
      inputHash: input.inputHash ?? null,
      ...(input.userId ? { enrollments: { create: { userId: input.userId } } } : {}),
    },
    select: { id: true },
  });

  try {
    const result = await plan(input);
    // H3 (audit 9.4): the trace's accumulated token usage for the plan pass
    // (decompose/gate/reconcile report into it via recordUsage). Null when the
    // caller didn't open a trace (scripts/tests) — persisted as DB NULL.
    const planUsage = traceUsageSnapshot();
    // Stage-0 goal gate rejected the goal (off-domain / nonsense). Persist the model's
    // reason for audit, but return a FIXED user-facing message — the reason is
    // model-written text and never echoed. The anchor row already exists (created
    // before this fallible plan pass), so this failed row is metered by H1's burst
    // (counts all statuses), excluded from the monthly quota (failed excluded), and
    // ignored by dedup (failed never matches) — the gate needs no separate limiter.
    if (result.goalRejected) {
      await failProgram(program.id, `goal rejected: ${result.goalRejected.reason}`, planUsage);
      logWarn('program.goal-rejected', { programId: program.id, reason: result.goalRejected.reason });
      return {
        programId: program.id,
        status: ProgramStatus.failed,
        topicCount: 0,
        error:
          'This goal is outside the subjects we cover — build programs for mathematics, the natural sciences, or computer science.',
        failureKind: 'goal_rejected',
      };
    }
    if (result.topics.length === 0) {
      const error = 'plan pass produced no in-domain topics';
      await failProgram(program.id, error, planUsage);
      logWarn('program.plan-empty', { programId: program.id, droppedByGate: result.droppedByGate });
      return { programId: program.id, status: ProgramStatus.failed, topicCount: 0, error, failureKind: 'plan_empty' };
    }

    // Fan out atomically: one ProgramPath slot + one child CourseRequest per topic,
    // then flip the Program to `building`. ProgramPath.trackId stays null until the
    // assembler fills it in; CourseRequest carries the per-topic budget + rationale.
    await prisma.$transaction(async (tx) => {
      for (const t of result.topics) {
        await tx.programPath.create({
          data: {
            programId: program.id,
            topic: t.key,
            phaseLabel: t.phaseLabel,
            orderInProgram: t.orderInProgram,
            priorityTier: t.priorityTier,
          },
        });
        await tx.courseRequest.create({
          data: {
            topic: t.key,
            programId: program.id,
            userId: input.userId ?? null,
            // Program background is the per-topic priorKnowledge in v1 (per-topic
            // threading is the deferred "seed" follow-on); the plan's per-topic
            // rationale is the child's goal (drives the composer's intent inference).
            priorKnowledge: input.background ?? null,
            goal: t.rationale,
            hoursPerWeek: t.hoursPerWeek,
            timeframeWeeks: t.timeframeWeeks,
            // Frontier requests the decompose-agent recorded for this topic; the
            // worker executes them (addFrontierConcept) before buildTrack.
            frontierConcepts: t.frontierConcepts,
            // targetMastery left null (composer defaults beginner) for v1.
          },
        });
      }
      await tx.program.update({
        where: { id: program.id },
        // Phase 3c: persist the plan's generated public-facing name alongside the
        // status flip — title/description are what non-creators see (goal stays
        // creator-private). Null when an injected/legacy plan doesn't carry them.
        data: {
          status: ProgramStatus.building,
          title: result.title ?? null,
          description: result.description ?? null,
          planUsage: planUsage ?? Prisma.JsonNull,
        },
      });
    });

    log('program.enqueued', {
      programId: program.id,
      topics: result.topics.map((t) => t.key),
      droppedByGate: result.droppedByGate.length,
      droppedByBudget: result.droppedByBudget.length,
      planUsage: planUsage?.totals,
    });
    return { programId: program.id, status: ProgramStatus.building, topicCount: result.topics.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError('program.plan-failed', { programId: program.id, error: message });
    // Usage may have accumulated before the throw (a failed retry still billed).
    await failProgram(program.id, message, traceUsageSnapshot());
    // A genuine server fault (Gemini/Vertex or Prisma threw) — persisted for audit,
    // but 'internal' so the route reports 500 and never echoes `message` to the client.
    return { programId: program.id, status: ProgramStatus.failed, topicCount: 0, error: message, failureKind: 'internal' };
  }
}

async function failProgram(
  programId: string,
  error: string,
  planUsage?: Prisma.InputJsonValue | null,
): Promise<void> {
  await prisma.program
    .update({
      where: { id: programId },
      data: { status: ProgramStatus.failed, error, planUsage: planUsage ?? Prisma.JsonNull },
    })
    .catch(() => {});
}

type FulfilledSibling = {
  id: string;
  topic: string;
  trackId: string;
  replacesTrackId: string | null;
  userId: string | null;
  carriedOverAt: Date | null;
};

// Stamp the "carry-over settled" marker, but only from unset — so two concurrent
// assembler passes can both run this and the second is a no-op rather than a second
// carry-over.
const markCarriedOver = (requestId: string) =>
  prisma.courseRequest.updateMany({
    where: { id: requestId, carriedOverAt: null },
    data: { carriedOverAt: new Date() },
  });

// Reports R6/F5: the progress carry-over for every REBUILD among the fulfilled siblings.
//
// Runs AFTER the repoint transaction, not inside it (F5, R6 #4): an insert failure here
// must not roll the slot repoint back — a rebuilt course the learner has to re-tick is
// bad, one that never becomes visible is worse. The cost is that the new Track can be
// visible with an empty progress bar for the moment between the two commits; the marker
// below is what makes that moment recoverable rather than permanent.
//
// Idempotence is the marker's job, not the Progress rows' (F5, Stack #3). Inferring
// "already carried" from progress on the new Track meant a learner who un-ticked every
// carried lesson had them re-inserted by the next assembler pass — and that pass runs
// after EVERY sibling of the program terminates, forever.
//
// Only the winner per topic is carried: the repoint applies its updateMany calls in
// sibling order, so for a topic with several fulfilled builds the last one is the Track
// the learner will actually see, and crediting a loser's lessons would write progress
// into a Track nothing points at. Losers are still marked settled, so the pending sweep
// converges instead of re-examining them every tick.
async function applyCarryOvers(programId: string, fulfilled: FulfilledSibling[]): Promise<void> {
  const winners = new Map(fulfilled.map((s) => [s.topic, s]));
  const pending = fulfilled.filter((s) => s.replacesTrackId != null && s.carriedOverAt == null);

  for (const rebuild of pending) {
    // `userId`/`replacesTrackId` are non-null by the filter above; re-read defensively
    // rather than asserting, so the narrowing survives a later edit to that filter.
    const { userId, replacesTrackId } = rebuild;
    const superseded = winners.get(rebuild.topic)?.id !== rebuild.id;
    if (!userId || !replacesTrackId || replacesTrackId === rebuild.trackId || superseded) {
      await markCarriedOver(rebuild.id);
      continue;
    }
    try {
      const plan = await planCarryOver({ userId, oldTrackId: replacesTrackId, newTrackId: rebuild.trackId });
      log('program.carry-over-planned', {
        programId,
        requestId: rebuild.id,
        topic: rebuild.topic,
        userId,
        oldTrackId: replacesTrackId,
        newTrackId: rebuild.trackId,
        completedBefore: plan.completedBefore,
        carried: plan.lessons.length,
      });
      // Inserts and marker commit together: either this rebuild is settled and its
      // rows exist, or neither happened and the sweep retries it.
      const ops: Prisma.PrismaPromise<unknown>[] = [];
      if (plan.lessons.length > 0) {
        ops.push(
          prisma.progress.createMany({
            // completedAt comes from the covering old lesson, NOT from now(): the row
            // stands for work done then, and it is what the course page's own progress
            // ordering reads. carriedFromLessonId is what keeps that honest — the old
            // Track's rows are deliberately kept, so without the marker a carried row
            // would be a SECOND completion event on a day the learner already studied,
            // and the carry is not 1:1, so the inflation factor is arbitrary. Consumers
            // that count events (the home heatmap) skip marked rows.
            data: plan.lessons.map((lesson) => ({
              userId,
              lessonId: lesson.id,
              completedAt: lesson.completedAt,
              carriedFromLessonId: lesson.fromLessonId,
            })),
            skipDuplicates: true,
          }),
        );
      }
      ops.push(markCarriedOver(rebuild.id));
      await prisma.$transaction(ops);
    } catch (err) {
      // Left unmarked on purpose: sweepPendingCarryOvers retries it on a later tick.
      logError('program.carry-over-failed', { programId, requestId: rebuild.id, err });
    }
  }
}

// The worker's post-fulfill hook: called after a child CourseRequest reaches a
// terminal state. If ALL siblings of the program are terminal, fill each fulfilled
// slot's trackId and finalize the Program (ready | partial | failed). A no-op while
// any sibling is still queued/running.
//
// Workers-A2 concurrency note: under N workers, two workers finishing the LAST two
// siblings can race — each reads the other's child as still `running` and both
// skip. That's a latency wart, NOT a correctness bug: sweepStuckPrograms (every
// worker tick) finds the stranded `building` Program and re-runs this assembler,
// and the updateMany status guard below keeps a double/concurrent finalize
// idempotent (exactly one caller flips the status and logs). Do not "fix" the race
// here with a lock — the sweep is the designed recovery path.
export async function maybeAssembleProgram(programId: string): Promise<void> {
  // Reports R5: ordered by createdAt because a REBUILD (a second CourseRequest with
  // the same programId + topic, replacesTrackId set) means a topic can now have more
  // than one fulfilled sibling. The repoint below applies them in this array's order,
  // so without an ORDER BY the winner is whatever order Postgres happened to return —
  // i.e. the rebuild could be silently overwritten by the Track it replaced. Oldest
  // first, so the newest fulfilled build writes last and wins.
  const siblings = await prisma.courseRequest.findMany({
    where: { programId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      topic: true,
      trackId: true,
      replacesTrackId: true,
      userId: true,
      carriedOverAt: true,
    },
  });
  if (siblings.length === 0) return;

  const isTerminal = (s: CourseRequestStatus) =>
    s === CourseRequestStatus.fulfilled || s === CourseRequestStatus.failed;
  if (!siblings.every((s) => isTerminal(s.status))) return; // still building

  // Link each fulfilled child's Track to its plan slot (idempotent). Matched on
  // (programId, topic) — unique per Program, so exactly one slot per fulfilled topic.
  const fulfilled = siblings.filter(
    (s): s is typeof s & { trackId: string } =>
      s.status === CourseRequestStatus.fulfilled && s.trackId != null,
  );
  if (fulfilled.length > 0) {
    await prisma.$transaction(
      fulfilled.map((s) =>
        prisma.programPath.updateMany({
          where: { programId, topic: s.topic },
          data: { trackId: s.trackId },
        }),
      ),
    );
    // Deliberately before the status flip below, which is guarded to fire once: the
    // carry-over must stay reachable on every re-run of the assembler, including for a
    // Program that is already `ready` (a rebuild's own assembly is exactly that case).
    await applyCarryOvers(programId, fulfilled);
  }

  const anyFulfilled = siblings.some((s) => s.status === CourseRequestStatus.fulfilled);
  const anyFailed = siblings.some((s) => s.status === CourseRequestStatus.failed);
  const finalStatus =
    anyFulfilled && anyFailed
      ? ProgramStatus.partial
      : anyFulfilled
        ? ProgramStatus.ready
        : ProgramStatus.failed;

  // Finalize only from a non-terminal state → idempotent, and logs exactly once.
  const { count } = await prisma.program.updateMany({
    where: { id: programId, status: { in: [ProgramStatus.planning, ProgramStatus.building] } },
    data: { status: finalStatus },
  });
  if (count > 0) await logBuiltProgram(programId, finalStatus);
}

// The stuck-Program backstop. maybeAssembleProgram only runs inline after a child
// finishes (course-worker), and a failure there is swallowed as non-fatal — so if
// the hook throws on the LAST sibling, or the worker dies between finishCourseRequest
// and the hook, the Program stays `building` forever with every child terminal.
// reclaimStale only bounces `running` CourseRequests; nothing else re-triggers
// assembly. This sweep finds those stranded Programs — `building`, ≥1 child, none
// still non-terminal — and re-runs the (idempotent) assembler on each. Returns how
// many it found, for the worker's per-cycle log.
//
// The `some: {}` guard is deliberate: a `building` Program with ZERO children (mid
// fan-out, before the transaction commits) is NOT swept — we must not finalize it to
// `failed`. maybeAssembleProgram's updateMany status guard keeps the re-run safe if a
// Program finalized concurrently.
export async function sweepStuckPrograms(): Promise<number> {
  const stuck = await prisma.program.findMany({
    where: {
      status: ProgramStatus.building,
      courseRequests: { some: {} },
      AND: [
        {
          courseRequests: {
            none: { status: { in: [CourseRequestStatus.queued, CourseRequestStatus.running] } },
          },
        },
      ],
    },
    select: { id: true },
  });
  for (const p of stuck) await maybeAssembleProgram(p.id);
  return stuck.length;
}

// Reports F5: the carry-over backstop. sweepStuckPrograms cannot serve this — it selects
// `building` Programs, and a rebuild's Program is `ready` throughout (R5 leaves it that
// way deliberately). So a carry-over that threw, or whose transaction failed, has no
// other route back: the assembler only re-runs when another sibling terminates, which
// may be never.
//
// Re-runs the whole (idempotent) assembler for each Program holding an unsettled
// rebuild, rather than carrying the row directly, so the winner-per-topic rule and the
// repoint stay in one place. Returns how many Programs it touched, for the worker log.
//
// Both bounds below exist because this sweep runs on every tick of every worker and
// nothing here can mark a row it cannot reach — an unbounded predicate is an infinite
// retry loop, not a backstop:
//   - `trackId != null` mirrors the assembler's own filter. CourseRequest.trackId is
//     SetNull, so a fulfilled rebuild whose Track was deleted is a row applyCarryOvers
//     never sees and therefore can never settle.
//   - the age window bounds a carry-over that throws DETERMINISTICALLY. Nothing rewrites
//     a fulfilled request while its carry-over is pending, so `updatedAt` is effectively
//     "when it was fulfilled"; past the window the row is left unsettled (and logged, per
//     attempt, by applyCarryOvers) rather than retried forever.
const CARRY_OVER_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function sweepPendingCarryOvers(): Promise<number> {
  const pending = await prisma.courseRequest.findMany({
    where: {
      status: CourseRequestStatus.fulfilled,
      replacesTrackId: { not: null },
      trackId: { not: null },
      carriedOverAt: null,
      programId: { not: null },
      updatedAt: { gte: new Date(Date.now() - CARRY_OVER_RETRY_WINDOW_MS) },
    },
    select: { programId: true },
    distinct: ['programId'],
  });
  for (const row of pending) if (row.programId) await maybeAssembleProgram(row.programId);
  return pending.length;
}

// The "program ready" notification stub (mirrors course-worker's logBuiltTrack):
// print a readable, phase-grouped summary of the assembled Program. Phase 3 replaces
// this with the learner notification. Best-effort — never throws.
async function logBuiltProgram(programId: string, status: ProgramStatus): Promise<void> {
  try {
    const program = await prisma.program.findUniqueOrThrow({
      where: { id: programId },
      select: {
        goal: true,
        totalHoursPerWeek: true,
        totalWeeks: true,
        userId: true,
        programPaths: {
          orderBy: { orderInProgram: 'asc' },
          select: {
            orderInProgram: true,
            topic: true,
            phaseLabel: true,
            priorityTier: true,
            track: { select: { title: true, status: true, lessons: { select: { id: true } } } },
          },
        },
      },
    });
    const icon = status === ProgramStatus.ready ? '🎓' : status === ProgramStatus.partial ? '◐' : '✖';
    const lines = [
      '',
      '═══════════════════════════════════════════════════════════════',
      `${icon} PROGRAM ${status.toUpperCase()}  (Program ${programId}${program.userId ? `, user ${program.userId}` : ''})`,
      `   goal: ${program.goal}`,
      `   budget: ${program.totalHoursPerWeek} h/wk × ${program.totalWeeks} weeks`,
      `   ${program.programPaths.length} topic(s):`,
      ...program.programPaths.map((p) => {
        const built = p.track
          ? `✓ "${p.track.title ?? '(untitled)'}" [${p.track.status}, ${p.track.lessons.length} lessons]`
          : '✗ not built';
        const tier = p.priorityTier === 'core' ? 'core' : 'nice';
        return `     ${String(p.orderInProgram).padStart(2)}. ${p.topic.padEnd(24)} (${tier}) {${p.phaseLabel}}  → ${built}`;
      }),
      '═══════════════════════════════════════════════════════════════',
      '',
    ];
    console.log(lines.join('\n'));
  } catch (err) {
    console.warn('[program] logBuiltProgram failed (non-fatal)', { programId, err });
  }
}
