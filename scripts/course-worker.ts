// Phase 2.5g-3: the out-of-band course worker — the standalone poll loop that
// drains the CourseRequest queue. The fire-and-forget route (g-4) enqueues; this
// process does the slow work (ensurePathMap → remediate → buildTrack → notify).
//
//   npx tsx --env-file=.env.local scripts/course-worker.ts          # --watch (default)
//   npx tsx --env-file=.env.local scripts/course-worker.ts --once   # claim+process one, exit
//
// Portable, no Vercel Cron (see AGENTS.md): run it as a long-lived process (the
// Cloud Run end state), or drive --once from any external scheduler (a GitHub
// Actions cron, etc.). --once exits 0 whether or not it found work, so it's safe to
// fire on a schedule.
//
// Workers-A2: safe to run N instances. Each stamps its claims with a worker id
// (Cloud Run instance id / hostname + pid — D6), same-topic contention requeues
// with backoff instead of failing (D2), and SIGTERM/SIGINT gracefully RELEASES the
// in-flight job (abort → requeue, immediately claimable) so a deploy's instance
// churn hands work to a surviving worker within seconds instead of stranding it
// for the 45m stale window (D7).

import os from 'node:os';
import { COURSE_WORKER_POLL_MS } from '../src/lib/config';
import { prisma } from '../src/lib/db';
import { tickOnce, reclaimStaleClaims, processCourseRequest } from '../src/lib/services/course-worker';
import { claimNextQueued } from '../src/lib/services/course-request';
import { sweepStuckPrograms } from '../src/lib/services/program';

// D6: worker identity, stamped on every claim (CourseRequest.claimedBy) and
// carried in log lines. Cloud Run worker pools expose CLOUD_RUN_INSTANCE_ID;
// locally the hostname + pid distinguishes two side-by-side dev workers.
const workerId = `${process.env.CLOUD_RUN_INSTANCE_ID ?? os.hostname()}:${process.pid}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  console.log(`[course-worker ${workerId}] --once: reclaim + claim + process one`);
  const did = await tickOnce({ workerId });
  console.log(did ? `[course-worker ${workerId}] processed one request` : `[course-worker ${workerId}] queue empty, nothing to do`);
}

async function runWatch() {
  let running = true;
  // D7: one long-lived shutdown controller. Its abort propagates into the
  // in-flight job (processCourseRequest aborts the per-job pipeline controller,
  // AI calls stop at their next checkpoint, the claim is requeued) — so a signal
  // exits within seconds, not after the current 30m-deadline job.
  const shutdown = new AbortController();
  const stop = (sig: string) => {
    console.log(`[course-worker ${workerId}] ${sig} received — releasing in-flight claim, then exiting`);
    running = false;
    shutdown.abort(new Error(`${sig} shutdown`));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  console.log(`[course-worker ${workerId}] --watch: polling every ${COURSE_WORKER_POLL_MS}ms (Ctrl-C to stop)`);
  while (running) {
    // Reclaim once per cycle, then drain the queue fully before sleeping.
    const reclaimed = await reclaimStaleClaims();
    if (reclaimed.courseRequests || reclaimed.remediationJobs) {
      console.log(`[course-worker ${workerId}] reclaimed stale claims`, reclaimed);
    }
    // Re-run assembly for any Program stranded in `building` (last-sibling hook
    // failure, the A2 two-last-siblings race, or a worker crash after
    // finishCourseRequest) — reclaim doesn't cover it.
    const swept = await sweepStuckPrograms();
    if (swept) console.log(`[course-worker ${workerId}] swept stuck programs`, { swept });
    let cr;
    while (running && (cr = await claimNextQueued(workerId))) {
      // A 'requeued' outcome (contention) keeps draining: the bounced row is
      // ineligible for COURSE_CONTENTION_REQUEUE_MS, so the claim loop moves on
      // to other work rather than self-spinning on it (asserted in the A1 queue
      // tests: a future nextAttemptAt row is unclaimable).
      await processCourseRequest(cr, { shutdownSignal: shutdown.signal });
    }
    if (running) await sleep(COURSE_WORKER_POLL_MS);
  }
  console.log(`[course-worker ${workerId}] stopped.`);
}

async function main() {
  const once = process.argv.slice(2).includes('--once');
  if (once) await runOnce();
  else await runWatch();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[course-worker] fatal', err);
  await prisma.$disconnect();
  process.exit(1);
});
