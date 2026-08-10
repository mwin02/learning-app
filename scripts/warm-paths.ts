// Free-beta C1: the warm-path driver — take the warm topic set to `spine_ready`
// so beta learners hit pre-built maps instead of waiting on a cold build.
//
//   npx tsx --env-file=.env.local scripts/warm-paths.ts                  # all 12 warm topics
//   npx tsx --env-file=.env.local scripts/warm-paths.ts python sql       # just these
//   npx tsx --env-file=.env.local scripts/warm-paths.ts --force          # ignore the skip rule
//   npx tsx --env-file=.env.local scripts/warm-paths.ts --concurrency 3
//
// This is scripts/prewarm.ts generalized to N topics, and it deliberately does
// NOT go through the CourseRequest queue. A CourseRequest is Track-oriented: the
// worker pipeline is ensurePathMap → remediate → buildTrack → finish, and a Track
// is a per-LEARNER snapshot built from learner inputs (goal, timeframe, hours).
// Warming wants the layer BELOW that — the shared Path/map — so enqueueing would
// manufacture husk Tracks with null inputs purely as a side effect, and would
// couple this script to a draining worker fleet. The queue stays for real learner
// requests; warming calls the same two stages directly.
//
// Idempotent: a topic whose Path is already `spine_ready` is skipped unless
// --force. --force does NOT wipe anything (that's reset-maps.ts) — it re-runs the
// stages, which also bypasses remediation's recently-escalated cool-down, so it's
// the right flag after new resources land in the library for a stuck topic.

import { PathStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { ensurePathMap } from '../src/lib/agents/map/ensure-path-map';
import { remediatePath } from '../src/lib/agents/track/remediate-path';
import { TOPIC_SLUGS } from '../src/types/resource';

// The warm set: every curated topic except `go` (off-niche for the beta — stays
// available on demand, just not pre-built). See free-beta.md § C2.
const WARM_TOPICS: string[] = TOPIC_SLUGS.filter((t) => t !== 'go');

// Remediation is web-sourcing + LLM-heavy per hole, so keep the default low: this
// is minutes-per-topic work and the sourcing prongs hit shared rate-limited APIs.
const DEFAULT_CONCURRENCY = 2;

type Outcome = {
  topic: string;
  before: string;
  after: string;
  // 'skipped' = not touched (already ready); 'ready' = stages ran but found
  // nothing open (the common --force case); 'built' = holes were actually filled.
  action: 'skipped' | 'ready' | 'built' | 'failed';
  holes: number;
  escalated: number;
  seconds: number;
};

function parseArgs(argv: string[]) {
  const force = argv.includes('--force');
  const flagIdx = argv.findIndex((a) => a === '--concurrency' || a.startsWith('--concurrency='));
  let concurrency = DEFAULT_CONCURRENCY;
  if (flagIdx !== -1) {
    const raw = argv[flagIdx].includes('=') ? argv[flagIdx].split('=')[1] : argv[flagIdx + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency needs a positive integer, got: ${raw}`);
    concurrency = n;
  }
  // Positionals = explicit topic list; the --concurrency value is not one.
  const consumed = flagIdx !== -1 && !argv[flagIdx].includes('=') ? flagIdx + 1 : -1;
  const topics = argv.filter((a, i) => !a.startsWith('-') && i !== consumed);
  return { force, concurrency, topics: topics.length > 0 ? topics : WARM_TOPICS };
}

async function warmOne(topic: string, force: boolean): Promise<Outcome> {
  const t0 = Date.now();
  const secs = () => +((Date.now() - t0) / 1000).toFixed(0);
  const existing = await prisma.path.findUnique({ where: { topic }, select: { status: true } });
  const before = existing?.status ?? 'none';

  if (!force && existing?.status === PathStatus.spine_ready) {
    console.log(`[warm:${topic}] already spine_ready — skipping (use --force to re-run)`);
    return { topic, before, after: before, action: 'skipped', holes: 0, escalated: 0, seconds: secs() };
  }

  try {
    const map = await ensurePathMap({ topic });
    console.log(`[warm:${topic}] ensurePathMap → status=${map.status} pathId=${map.pathId} created=${map.created}`);

    let holes = 0;
    let escalated = 0;
    let noop = false;
    let status: string = map.status;
    // A fresh spine over a thin library is all holes; remediation fills them via
    // the sourcing ladder. --force also re-runs on an already-ready Path, where
    // remediatePath short-circuits to `ready` if there is genuinely nothing open.
    if (map.status === PathStatus.building || force) {
      console.log(`[warm:${topic}] remediating (sources from the web — minutes)…`);
      const rem = await remediatePath(map.pathId, { force });
      holes = rem.holes.length;
      escalated = rem.escalatedConceptSlugs.length;
      status = rem.status;
      noop = rem.outcome === 'ready';
      console.log(`[warm:${topic}] remediate → outcome=${rem.outcome} status=${rem.status} holes=${holes} relaxed=${rem.relaxedConceptSlugs.length} escalated=${escalated}`);
    }

    const action = status !== PathStatus.spine_ready ? 'failed' : noop ? 'ready' : 'built';
    return { topic, before, after: status, holes, escalated, seconds: secs(), action };
  } catch (e) {
    // One topic's failure must not abandon the other eleven — record and move on.
    console.error(`[warm:${topic}] FAILED:`, e);
    return { topic, before, after: 'error', action: 'failed', holes: 0, escalated: 0, seconds: secs() };
  }
}

// Fixed-size worker pool over a shared cursor: N runners pull the next topic as
// they free up, so a slow topic never blocks the queue behind it.
async function runPool(topics: string[], concurrency: number, force: boolean): Promise<Outcome[]> {
  const results: Outcome[] = new Array(topics.length);
  let cursor = 0;
  const runner = async () => {
    while (cursor < topics.length) {
      const i = cursor++;
      results[i] = await warmOne(topics[i], force);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, topics.length) }, runner));
  return results;
}

async function main() {
  const { force, concurrency, topics } = parseArgs(process.argv.slice(2));
  console.log(`\n=== warm paths: ${topics.length} topic(s), concurrency=${concurrency}${force ? ', FORCE' : ''} ===`);
  console.log(topics.join(', '));

  const t0 = Date.now();
  const results = await runPool(topics, concurrency, force);

  console.log(`\n── warm summary (${((Date.now() - t0) / 1000 / 60).toFixed(1)} min) ──`);
  console.table(
    Object.fromEntries(results.map((r) => [
      r.topic,
      { action: r.action, before: r.before, after: r.after, holes: r.holes, escalated: r.escalated, secs: r.seconds },
    ])),
  );

  const failed = results.filter((r) => r.action === 'failed');
  const ready = results.filter((r) => r.after === PathStatus.spine_ready);
  console.log(`\n${ready.length}/${results.length} spine_ready` + (failed.length ? `  |  NOT ready: ${failed.map((f) => f.topic).join(', ')}` : ''));
  // Non-zero exit so a scripted campaign run surfaces the shortfall.
  if (failed.length > 0) process.exitCode = 1;
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
