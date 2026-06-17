// Phase 2.5f-5: manual driver for spine-hole remediation.
//
//   npx tsx --env-file=.env.local scripts/remediate.ts <topic|pathId> [--force]
//
// Runs remediatePath on a `building` Path: classify each hole, source gaps /
// split conflations, relax or escalate the leftovers, and flip the Path to
// `spine_ready` when whole. The arg is a topic slug (resolved via @@unique[topic])
// or a Path id. `--force` claims over a stale in-flight job (a worker that died
// mid-run); normal single-flight otherwise returns `busy`.
//
// This is the manual invoker until 2.5g wires the request-path enqueue + worker.
// It runs synchronously (minutes of web sourcing), which is fine for a CLI.

import { prisma } from '../src/lib/db';
import { remediatePath } from '../src/lib/agents/track/remediate-path';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage: tsx --env-file=.env.local scripts/remediate.ts <topic|pathId> [--force]');
    process.exit(1);
  }

  // Resolve a topic slug to its Path id; otherwise treat the arg as a Path id.
  const byTopic = await prisma.path.findUnique({ where: { topic: target }, select: { id: true, topic: true, status: true } });
  const path = byTopic ?? (await prisma.path.findUnique({ where: { id: target }, select: { id: true, topic: true, status: true } }));
  if (!path) {
    console.error(`No Path found for topic or id '${target}'.`);
    process.exit(1);
  }

  console.log(`[remediate-cli] ${path.topic} (${path.id}) status=${path.status}${force ? ' --force' : ''}`);
  const start = Date.now();
  const result = await remediatePath(path.id, { force });
  const secs = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`[remediate-cli] done in ${secs}s:`, result);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
