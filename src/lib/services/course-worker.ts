// Phase 2.5g-3: the course worker pipeline — what runs out-of-band for one claimed
// CourseRequest. The fire-and-forget route (g-4) only enqueues + acks; this is the
// slow part, kept off the request path (no Vercel function-timeout ceiling here).
//
//   claim (caller) → ensurePathMap(topic)
//     → if `building`: remediatePath (fill spine holes; relax/escalate on exhaustion)
//     → if now `spine_ready`: buildTrack(learner inputs) → log the Track → fulfilled
//     → else (still building/failed): fail the request with a diagnostic
//
// Notification is deferred (Phase 3 needs User.email): on success we log a readable
// Track summary to stdout — the exact hook the "course ready" email later replaces.
//
// tickOnce() is the unit the CLI loop (scripts/course-worker.ts) drives: reclaim
// stale claims, then claim + process at most one request. Workers-A2: safe at
// N > 1 workers — the ensurePathMap advisory lock + RemediationJob single-flight
// serialize same-topic builds, and a worker that loses that race requeues the
// request with backoff (`requeued`) instead of failing it.

import { PathStatus } from '@prisma/client';
import type { CourseRequest } from '@prisma/client';
import { ensurePathMap } from '@/lib/agents/map/ensure-path-map';
import { remediatePath } from '@/lib/agents/track/remediate-path';
import { buildTrack } from '@/lib/agents/track/build-track';
import { backfillConceptBanks } from '@/lib/agents/content/generate-concept-bank';
import { addFrontierConcept } from '@/lib/agents/track/add-frontier-concept';
import {
  COURSE_CONTENTION_REQUEUE_MS,
  COURSE_JOB_DEADLINE_MS,
  COURSE_SHUTDOWN_GRACE_MS,
  MAX_FRONTIER_PER_TOPIC,
} from '@/lib/config';
import { log, logError, logWarn, runWithTrace, traceUsageSnapshot } from '@/lib/log';
import { reclaimStaleRemediationJobs } from '@/lib/agents/track/remediation-job';
import {
  claimNextQueued,
  finishCourseRequest,
  reclaimStale,
  requeueCourseRequest,
} from '@/lib/services/course-request';
import { maybeAssembleProgram, sweepStuckPrograms } from '@/lib/services/program';

// Workers-A2: `requeued` is NON-terminal — the request went back to `queued` (topic
// contention backoff, or a graceful-shutdown release) and a later claim retries it.
export type ProcessOutcome = 'fulfilled' | 'failed' | 'requeued';

// Injectable pipeline stages (same `opts` pattern as enqueueProgram's `plan`): the
// expensive/LLM-backed steps default to the real implementations, so production
// callers pass nothing, while tests stub them to exercise the branch logic without an
// LLM. finishCourseRequest stays real (the DB write the tests assert against).
export type PipelineStages = {
  ensureMap?: typeof ensurePathMap;
  remediate?: typeof remediatePath;
  build?: typeof buildTrack;
  backfillBanks?: typeof backfillConceptBanks;
  addFrontier?: typeof addFrontierConcept;
};

// processCourseRequest adds three more seams over the pipeline: the post-fulfill
// Program assembler hook (so its fires / failure-is-non-fatal behavior is
// observable in tests), the H4 per-job deadline (so tests can use a short one),
// and the Workers-A2 shutdown signal (D7): the CLI's SIGTERM controller. When it
// aborts, the in-flight job is REQUEUED (not failed) so a surviving worker picks
// it up immediately, distinguishing a graceful release from a deadline abort.
export type ProcessOpts = PipelineStages & {
  assembleProgram?: (programId: string) => Promise<void>;
  deadlineMs?: number;
  shutdownSignal?: AbortSignal;
  // Audit 2.3: how long a shutdown abort waits for the pipeline to settle before
  // the claim is proactively requeued. Injectable (like deadlineMs) so tests can
  // use a short grace against a non-observing stage.
  shutdownGraceMs?: number;
};

// Reclaim both queues' dead-worker claims. Run once per poll cycle BEFORE claiming,
// so a request/job orphaned by a crashed worker is freed rather than stuck.
export async function reclaimStaleClaims(): Promise<{ courseRequests: number; remediationJobs: number }> {
  const [courseRequests, remediationJobs] = await Promise.all([
    reclaimStale(),
    reclaimStaleRemediationJobs(),
  ]);
  return { courseRequests, remediationJobs };
}

// Run the per-topic pipeline for one claimed request, then — if it's a child of a
// Program (2.75c) — fire the assembler hook. The hook is a no-op until this request
// was the last sibling to reach a terminal state, at which point it finalizes the
// Program. Non-fatal: a hook failure must never fail an already-recorded request.
export async function processCourseRequest(cr: CourseRequest, opts: ProcessOpts = {}): Promise<ProcessOutcome> {
  // H3 (audit 9.4): the whole job runs inside a trace keyed by the request id —
  // every log line below (and in the agents underneath) carries traceId=cr.id,
  // and recordUsage calls anywhere in the pipeline accumulate into the snapshot
  // finishCourseRequest persists as CourseRequest.buildUsage.
  return runWithTrace(cr.id, async () => {
    // H4 (audit 1.3): race the pipeline against the per-job deadline. The
    // single-concurrency loop awaits this function, so a hung upstream call
    // would otherwise stall the whole queue. On expiry: abort the pipeline's
    // signal (stages stop at their next checkpoint / AI call), fail the request
    // with a diagnostic, and let the loop move on. If the losing pipeline
    // finishes anyway (a zombie, not truly hung), its own finishCourseRequest
    // is a no-op — the status='running' guard sees the row already failed.
    const deadlineMs = opts.deadlineMs ?? COURSE_JOB_DEADLINE_MS;
    const controller = new AbortController();
    // Workers-A2 (D7): a shutdown abort also aborts the per-job controller, so
    // in-flight AI calls stop at their next checkpoint. Requeue-vs-fail stays a
    // single idempotent target state: every path (pipeline catch, deadline
    // handler, grace timer below) funnels through requeueShutdown, whose
    // status='running' guard makes any later duplicate write a no-op.
    //
    // Audit 2.3: the graceful release must NOT depend on the in-flight stage
    // observing the abort — the unthreaded stretches (remediation's per-hole
    // loop, until Block 4) run minutes between checkpoints, and compose/Cloud
    // Run SIGKILLs 30s after SIGTERM, which would strand the claim `running`
    // for the full 45m stale window. So on shutdown we also start a short grace
    // timer; if the pipeline hasn't settled when it expires, requeue the claim
    // directly and let the race resolve — the zombie pipeline's own eventual
    // requeue/finish no-ops on the guard.
    const shutdownSignal = opts.shutdownSignal;
    const graceMs = opts.shutdownGraceMs ?? COURSE_SHUTDOWN_GRACE_MS;
    let graceTimer: NodeJS.Timeout | undefined;
    let settleGrace!: (outcome: ProcessOutcome) => void;
    const shutdownGrace = new Promise<ProcessOutcome>((resolve) => {
      settleGrace = resolve;
    });
    const onShutdown = () => {
      controller.abort(new Error('worker shutdown'));
      graceTimer = setTimeout(async () => {
        logWarn('course-worker.shutdown-grace-expired', {
          id: cr.id,
          topic: cr.topic,
          graceMs,
        });
        settleGrace(await requeueShutdown(cr).catch(() => 'requeued' as const));
      }, graceMs);
    };
    if (shutdownSignal?.aborted) onShutdown();
    else shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ProcessOutcome>((resolve) => {
      timer = setTimeout(async () => {
        controller.abort(new Error(`job deadline exceeded (${deadlineMs}ms)`));
        // A shutdown that landed while a stage was hung (never observed its
        // abort signal): release the claim instead of failing it.
        if (shutdownSignal?.aborted) {
          resolve(await requeueShutdown(cr).catch(() => 'requeued' as const));
          return;
        }
        logError('course-worker.deadline-exceeded', { id: cr.id, topic: cr.topic, deadlineMs });
        await finishCourseRequest(cr.id, {
          status: 'failed',
          error: `job deadline exceeded after ${deadlineMs}ms — pipeline aborted`,
          buildUsage: traceUsageSnapshot(),
        }).catch(() => {});
        resolve('failed');
      }, deadlineMs);
    });

    let outcome: ProcessOutcome;
    try {
      outcome = await Promise.race([
        processRequestPipeline(cr, opts, controller.signal),
        deadline,
        shutdownGrace,
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      shutdownSignal?.removeEventListener('abort', onShutdown);
    }
    // Workers-A2: only TERMINAL outcomes count toward Program assembly — a
    // requeued child is still pending and must not trip the "all siblings
    // terminal" check early.
    if (cr.programId && outcome !== 'requeued') {
      const assembleProgram = opts.assembleProgram ?? maybeAssembleProgram;
      await assembleProgram(cr.programId).catch((err) =>
        logError('course-worker.assemble-failed', { programId: cr.programId, err }),
      );
    }
    return outcome;
  });
}

// The per-topic build pipeline: ensurePathMap → remediate → buildTrack → finish.
// Unchanged by the Program layer. Never throws: any failure is recorded on the
// request as `failed` with the error message, so the worker loop keeps draining.
//
// H4: `signal` is the deadline's AbortSignal, forwarded into each stage (they
// pass it to their AI SDK calls opportunistically — the deadline race above is
// the backstop where a deep call site doesn't). The throwIfAborted checkpoints
// between stages stop an aborted-but-not-yet-failed pipeline from STARTING new
// expensive work; the throw lands in the catch below, whose finishCourseRequest
// is a harmless no-op when the deadline handler already failed the row.
async function processRequestPipeline(
  cr: CourseRequest,
  opts: ProcessOpts = {},
  signal?: AbortSignal,
): Promise<ProcessOutcome> {
  const ensureMap = opts.ensureMap ?? ensurePathMap;
  const remediate = opts.remediate ?? remediatePath;
  const build = opts.build ?? buildTrack;
  const backfillBanks = opts.backfillBanks ?? backfillConceptBanks;
  const addFrontier = opts.addFrontier ?? addFrontierConcept;

  log('course-worker.processing', { id: cr.id, topic: cr.topic });
  try {
    const map = await ensureMap({ topic: cr.topic, abortSignal: signal });
    let status = map.status;
    log('course-worker.map-ready', { id: cr.id, pathId: map.pathId, status, reclaimed: map.reclaimed, inFlight: map.inFlight });

    // Workers-A2 (D2): another worker's spine build for this topic is plausibly
    // mid-flight (fresh empty `building` Path between its tx1 and tx2). Building
    // now would race it; remediating would steal its RemediationJob slot. Bounce
    // the request with backoff and let a later claim find the settled Path.
    if (map.inFlight) {
      return requeueContention(cr, 'topic build in flight');
    }

    // A `building` map (thin/novel topic, or a reclaimed rebuild that hit holes)
    // gets one remediation pass: source gaps / split conflations, then relax or
    // escalate the leftovers. remediatePath single-flights via RemediationJob.
    if (status === PathStatus.building) {
      signal?.throwIfAborted();
      const rem = await remediate(map.pathId, { abortSignal: signal });
      log('course-worker.remediation', { id: cr.id, outcome: rem.outcome, status: rem.status, escalated: rem.escalatedConceptSlugs });
      if (rem.outcome === 'busy') {
        // Workers-A2 (D2): under N workers this is EXPECTED contention — another
        // worker's remediation holds this Path's single-flight slot. Requeue with
        // backoff rather than build a Track on a not-ready Path (or fail a
        // learner for picking a popular topic).
        return requeueContention(cr, 'remediation busy — another job holds this Path');
      }
      status = rem.status;
    }

    if (status !== PathStatus.spine_ready) {
      // Remediation relaxed what it could and escalated the rest; the Path can't
      // gate a coherent Track. (remediatePath already logged the escalation.)
      await finishCourseRequest(cr.id, {
        status: 'failed',
        error: `Path '${map.pathId}' did not reach spine_ready (status=${status}); spine holes left uncoverable`,
        buildUsage: traceUsageSnapshot(),
      });
      return 'failed';
    }

    // Best-effort: author a question bank for any concept that lacks one, now that
    // the Path is spine_ready (spine concepts have their resources attached). Banks
    // are sampled into per-Lesson exercises at build (2.5h-4). Idempotent across
    // Tracks of this Path; non-fatal — a generation failure must never block the
    // Track the learner is waiting on.
    signal?.throwIfAborted();
    try {
      const banks = await backfillBanks({ pathId: map.pathId, abortSignal: signal });
      log('course-worker.concept-banks', { id: cr.id, pathId: map.pathId, ...banks });
    } catch (err) {
      logWarn('course-worker.bank-backfill-failed', {
        id: cr.id,
        pathId: map.pathId,
        err,
      });
    }

    // Best-effort: execute the request's recorded frontier-concept requests (the
    // decompose-agent decides them as data; this is the one execution point). Must
    // run BEFORE buildTrack — the composer snapshots the map's concepts at build
    // time, so a frontier concept added later would miss this learner's Track.
    // Sequential (each may web-source, 30–60s) and per-request non-fatal: one bad
    // request skips to the next, and no frontier failure ever fails the Track.
    if (cr.frontierConcepts.length > 0) {
      if (cr.frontierConcepts.length > MAX_FRONTIER_PER_TOPIC) {
        logWarn('course-worker.frontier-over-cap', {
          id: cr.id,
          requested: cr.frontierConcepts.length,
          cap: MAX_FRONTIER_PER_TOPIC,
        });
      }
      for (const request of cr.frontierConcepts.slice(0, MAX_FRONTIER_PER_TOPIC)) {
        signal?.throwIfAborted();
        try {
          const res = await addFrontier({ pathId: map.pathId, request, abortSignal: signal });
          log('course-worker.frontier-request', { id: cr.id, pathId: map.pathId, request, ...res });
        } catch (err) {
          logWarn('course-worker.frontier-request-failed', {
            id: cr.id,
            pathId: map.pathId,
            request,
            err,
          });
        }
      }
    }

    signal?.throwIfAborted();
    const track = await build({
      pathId: map.pathId,
      priorKnowledge: cr.priorKnowledge,
      goal: cr.goal,
      timeframeWeeks: cr.timeframeWeeks,
      hoursPerWeek: cr.hoursPerWeek,
      targetMastery: cr.targetMastery,
      abortSignal: signal,
    });

    await logBuiltTrack(cr, track.trackId);
    const buildUsage = traceUsageSnapshot();
    await finishCourseRequest(cr.id, { status: 'fulfilled', trackId: track.trackId, buildUsage });
    log('course-worker.fulfilled', {
      id: cr.id,
      trackId: track.trackId,
      lessons: track.lessonCount,
      buildUsage: buildUsage?.totals,
    });
    return 'fulfilled';
  } catch (err) {
    // Workers-A2 (D7): an abort caused by graceful shutdown releases the claim
    // (requeue, immediately claimable) instead of failing it — the surviving
    // workers pick it up on their next poll. Checked here, not in a separate
    // shutdown handler, so requeue-vs-fail is a single write path.
    if (opts.shutdownSignal?.aborted) {
      return requeueShutdown(cr).catch(() => 'requeued' as const);
    }
    const message = err instanceof Error ? err.message : String(err);
    logError('course-worker.failed', { id: cr.id, topic: cr.topic, error: message });
    await finishCourseRequest(cr.id, {
      status: 'failed',
      error: message,
      buildUsage: traceUsageSnapshot(),
    }).catch(() => {});
    return 'failed';
  }
}

// Workers-A2 (D2): bounce a contended request back to `queued` with the standard
// backoff. requeueCourseRequest enforces the attempts cap (D5) — a request that
// has already burned its claims fails terminally there, and we report which
// branch was taken as the outcome.
async function requeueContention(cr: CourseRequest, reason: string): Promise<ProcessOutcome> {
  const res = await requeueCourseRequest(cr.id, {
    delayMs: COURSE_CONTENTION_REQUEUE_MS,
    reason,
  });
  log('course-worker.requeued-contention', { id: cr.id, topic: cr.topic, reason, ...res });
  return res.failedAtCap ? 'failed' : 'requeued';
}

// Workers-A2 (D7): release a claim on graceful shutdown — delayMs 0, so a
// surviving worker's very next poll can claim it (the whole point of the
// graceful release vs. waiting out the 45m stale window). Like contention, the
// cap still applies: a poison request crash-looping through shutdowns fails
// terminally rather than bouncing forever.
async function requeueShutdown(cr: CourseRequest): Promise<ProcessOutcome> {
  const res = await requeueCourseRequest(cr.id, { delayMs: 0, reason: 'worker shutdown' });
  log('course-worker.requeued-shutdown', { id: cr.id, topic: cr.topic, ...res });
  return res.failedAtCap ? 'failed' : 'requeued';
}

// One worker tick: reclaim stale claims, then claim + process at most one request.
// Returns true if it processed one (the loop keeps going), false if the queue was
// empty (the loop sleeps). The CLI's --once mode is a single tickOnce().
// Workers-A2: workerId stamps the claim (D6, observability); shutdownSignal is the
// CLI's SIGTERM controller (D7, graceful release).
export async function tickOnce(opts: { workerId?: string; shutdownSignal?: AbortSignal } = {}): Promise<boolean> {
  await reclaimStaleClaims();
  // Backstop for Programs stranded in `building` (last-sibling hook failure or a
  // worker crash after finishCourseRequest) — reclaimStale doesn't re-trigger assembly.
  await sweepStuckPrograms();
  const cr = await claimNextQueued(opts.workerId);
  if (!cr) return false;
  await processCourseRequest(cr, { shutdownSignal: opts.shutdownSignal });
  return true;
}

// The "course ready" notification stub: log a readable summary of the built Track.
// Phase 3 replaces this with the email to cr.userId's address. Best-effort — a
// logging failure must never fail an already-built Track.
async function logBuiltTrack(cr: CourseRequest, trackId: string): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db');
    const track = await prisma.track.findUniqueOrThrow({
      where: { id: trackId },
      select: {
        title: true,
        summary: true,
        status: true,
        intent: true,
        lessons: {
          orderBy: { orderInTrack: 'asc' },
          select: {
            orderInTrack: true,
            title: true,
            estMinutes: true,
            resources: {
              where: { role: 'primary' },
              orderBy: { orderInLesson: 'asc' },
              select: { resource: { select: { title: true, url: true } } },
            },
          },
        },
      },
    });
    const lines = [
      '',
      '═══════════════════════════════════════════════════════════════',
      `📚 COURSE READY  (CourseRequest ${cr.id}${cr.userId ? `, user ${cr.userId}` : ''})`,
      `   topic: ${cr.topic}  |  intent: ${track.intent ?? '—'}  |  status: ${track.status}`,
      `   "${track.title ?? '(untitled)'}"`,
      track.summary ? `   ${track.summary}` : '',
      `   ${track.lessons.length} lesson(s):`,
      ...track.lessons.map((l) => {
        const prim = l.resources.map((r) => r.resource.title).join(' + ') || '(no primary)';
        return `     ${String(l.orderInTrack).padStart(2)}. ${l.title}  [${l.estMinutes}m]  → ${prim}`;
      }),
      '═══════════════════════════════════════════════════════════════',
      '',
    ].filter((s) => s !== '');
    console.log(lines.join('\n'));
  } catch (err) {
    logWarn('course-worker.log-built-track-failed', { trackId, err });
  }
}
