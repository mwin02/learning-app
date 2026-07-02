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
// fire on a schedule. Concurrency is 1 by design — run a single instance.

import { COURSE_WORKER_POLL_MS } from '../src/lib/config';
import { prisma } from '../src/lib/db';
import { tickOnce, reclaimStaleClaims, processCourseRequest } from '../src/lib/services/course-worker';
import { claimNextQueued } from '../src/lib/services/course-request';
import { sweepStuckPrograms } from '../src/lib/services/program';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  console.log('[course-worker] --once: reclaim + claim + process one');
  const did = await tickOnce();
  console.log(did ? '[course-worker] processed one request' : '[course-worker] queue empty, nothing to do');
}

async function runWatch() {
  let running = true;
  const stop = (sig: string) => {
    console.log(`[course-worker] ${sig} received — finishing current tick, then exiting`);
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  console.log(`[course-worker] --watch: polling every ${COURSE_WORKER_POLL_MS}ms (Ctrl-C to stop)`);
  while (running) {
    // Reclaim once per cycle, then drain the queue fully before sleeping.
    const reclaimed = await reclaimStaleClaims();
    if (reclaimed.courseRequests || reclaimed.remediationJobs) {
      console.log('[course-worker] reclaimed stale claims', reclaimed);
    }
    // Re-run assembly for any Program stranded in `building` (last-sibling hook
    // failure or a worker crash after finishCourseRequest) — reclaim doesn't cover it.
    const swept = await sweepStuckPrograms();
    if (swept) console.log('[course-worker] swept stuck programs', { swept });
    let cr;
    while (running && (cr = await claimNextQueued())) {
      await processCourseRequest(cr);
    }
    if (running) await sleep(COURSE_WORKER_POLL_MS);
  }
  console.log('[course-worker] stopped.');
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
