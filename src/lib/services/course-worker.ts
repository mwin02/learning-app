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
// stale claims, then claim + process at most one request. Concurrency is 1 by
// design (see CourseRequest schema note) — the inner ensurePathMap advisory lock +
// RemediationJob single-flight are the backstops if that ever changes.

import { PathStatus } from '@prisma/client';
import type { CourseRequest } from '@prisma/client';
import { ensurePathMap } from '@/lib/agents/map/ensure-path-map';
import { remediatePath } from '@/lib/agents/track/remediate-path';
import { buildTrack } from '@/lib/agents/track/build-track';
import { backfillConceptBanks } from '@/lib/agents/content/generate-concept-bank';
import { reclaimStaleRemediationJobs } from '@/lib/agents/track/remediation-job';
import {
  claimNextQueued,
  finishCourseRequest,
  reclaimStale,
} from '@/lib/services/course-request';

export type ProcessOutcome = 'fulfilled' | 'failed';

// Reclaim both queues' dead-worker claims. Run once per poll cycle BEFORE claiming,
// so a request/job orphaned by a crashed worker is freed rather than stuck.
export async function reclaimStaleClaims(): Promise<{ courseRequests: number; remediationJobs: number }> {
  const [courseRequests, remediationJobs] = await Promise.all([
    reclaimStale(),
    reclaimStaleRemediationJobs(),
  ]);
  return { courseRequests, remediationJobs };
}

// Run the full pipeline for one already-claimed (`running`) CourseRequest, and move
// it to a terminal state. Never throws: any failure is recorded on the request as
// `failed` with the error message, so the worker loop keeps draining.
export async function processCourseRequest(cr: CourseRequest): Promise<ProcessOutcome> {
  console.log('[course-worker] processing', { id: cr.id, topic: cr.topic });
  try {
    const map = await ensurePathMap({ topic: cr.topic });
    let status = map.status;
    console.log('[course-worker] map ready', { id: cr.id, pathId: map.pathId, status, reclaimed: map.reclaimed });

    // A `building` map (thin/novel topic, or a reclaimed rebuild that hit holes)
    // gets one remediation pass: source gaps / split conflations, then relax or
    // escalate the leftovers. remediatePath single-flights via RemediationJob.
    if (status === PathStatus.building) {
      const rem = await remediatePath(map.pathId);
      console.log('[course-worker] remediation', { id: cr.id, outcome: rem.outcome, status: rem.status, escalated: rem.escalatedConceptSlugs });
      if (rem.outcome === 'busy') {
        // Under single-worker concurrency this is an anomaly (stale jobs are
        // reclaimed by age before we get here). Fail with a retryable diagnostic
        // rather than build a Track on a not-ready Path.
        await finishCourseRequest(cr.id, {
          status: 'failed',
          error: 'remediation busy — another job holds this Path (likely a concurrency anomaly)',
        });
        return 'failed';
      }
      status = rem.status;
    }

    if (status !== PathStatus.spine_ready) {
      // Remediation relaxed what it could and escalated the rest; the Path can't
      // gate a coherent Track. (remediatePath already logged the escalation.)
      await finishCourseRequest(cr.id, {
        status: 'failed',
        error: `Path '${map.pathId}' did not reach spine_ready (status=${status}); spine holes left uncoverable`,
      });
      return 'failed';
    }

    // Best-effort: author a question bank for any concept that lacks one, now that
    // the Path is spine_ready (spine concepts have their resources attached). Banks
    // are sampled into per-Lesson exercises at build (2.5h-4). Idempotent across
    // Tracks of this Path; non-fatal — a generation failure must never block the
    // Track the learner is waiting on.
    try {
      const banks = await backfillConceptBanks({ pathId: map.pathId });
      console.log('[course-worker] concept banks', { id: cr.id, pathId: map.pathId, ...banks });
    } catch (err) {
      console.warn('[course-worker] concept bank backfill failed (non-fatal)', {
        id: cr.id,
        pathId: map.pathId,
        err,
      });
    }

    const track = await buildTrack({
      pathId: map.pathId,
      priorKnowledge: cr.priorKnowledge,
      goal: cr.goal,
      timeframeWeeks: cr.timeframeWeeks,
      hoursPerWeek: cr.hoursPerWeek,
      targetMastery: cr.targetMastery,
    });

    await logBuiltTrack(cr, track.trackId);
    await finishCourseRequest(cr.id, { status: 'fulfilled', trackId: track.trackId });
    console.log('[course-worker] fulfilled', { id: cr.id, trackId: track.trackId, lessons: track.lessonCount });
    return 'fulfilled';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[course-worker] failed', { id: cr.id, topic: cr.topic, error: message });
    await finishCourseRequest(cr.id, { status: 'failed', error: message }).catch(() => {});
    return 'failed';
  }
}

// One worker tick: reclaim stale claims, then claim + process at most one request.
// Returns true if it processed one (the loop keeps going), false if the queue was
// empty (the loop sleeps). The CLI's --once mode is a single tickOnce().
export async function tickOnce(): Promise<boolean> {
  await reclaimStaleClaims();
  const cr = await claimNextQueued();
  if (!cr) return false;
  await processCourseRequest(cr);
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
    console.warn('[course-worker] logBuiltTrack failed (non-fatal)', { trackId, err });
  }
}
