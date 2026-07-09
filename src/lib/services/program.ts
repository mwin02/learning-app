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
  // Set only when status=failed — the persisted diagnostic. Safe to echo to the
  // caller ONLY when failureKind='plan_empty' (a fixed, non-sensitive message); the
  // 'internal' message is a raw exception string and must not leave the server.
  error?: string;
  // Why the plan failed, so the HTTP boundary can pick the right status class:
  //   'plan_empty' — well-formed request, no in-domain topics survived → 422.
  //   'internal'   — an LLM/DB exception during plan or fan-out → 500 (generic).
  failureKind?: 'plan_empty' | 'internal';
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

// The worker's post-fulfill hook: called after a child CourseRequest reaches a
// terminal state. If ALL siblings of the program are terminal, fill each fulfilled
// slot's trackId and finalize the Program (ready | partial | failed). A no-op while
// any sibling is still queued/running.
//
// Race-freedom rests on single-worker concurrency (same assumption as the queue
// itself): one worker drains the queue, so no two children finalize concurrently.
// The updateMany status guard still makes the finalize idempotent + safe against a
// double call.
export async function maybeAssembleProgram(programId: string): Promise<void> {
  const siblings = await prisma.courseRequest.findMany({
    where: { programId },
    select: { status: true, topic: true, trackId: true },
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
