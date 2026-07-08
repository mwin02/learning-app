// Pre-Freeze Map Review (Block 2): manual driver for the whole-map review.
//
//   npx tsx --env-file=.env.local scripts/review-map.ts <topic|pathId>
//
// Runs reviewAndPersistMap on ANY Path — regardless of status — for on-demand
// review and for BACKFILL over already-frozen Paths (the automatic freeze hook in
// remediatePath only fires on new building → spine_ready transitions, so it never
// re-reviews a Path that was already frozen). The arg is a topic slug (resolved via
// @@unique[topic]) or a Path id.
//
// This makes ONE Flash critic call + a hollow pass, then writes findings to the
// PathReview worklist idempotently (replaces open rows, preserves resolved ones).
// It does NOT mutate the map or Path.status — detect-and-flag only.

import { prisma } from '../src/lib/db';
import { reviewAndPersistMap } from '../src/lib/agents/map/run-map-review';

async function main() {
  const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage: tsx --env-file=.env.local scripts/review-map.ts <topic|pathId>');
    process.exit(1);
  }

  // Resolve a topic slug to its Path id; otherwise treat the arg as a Path id.
  const byTopic = await prisma.path.findUnique({ where: { topic: target }, select: { id: true, topic: true, status: true } });
  const path = byTopic ?? (await prisma.path.findUnique({ where: { id: target }, select: { id: true, topic: true, status: true } }));
  if (!path) {
    console.error(`No Path found for topic or id '${target}'.`);
    process.exit(1);
  }

  console.log(`[review-map-cli] ${path.topic} (${path.id}) status=${path.status}`);
  const start = Date.now();
  const { findings, written } = await reviewAndPersistMap(path.id);
  const secs = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`[review-map-cli] done in ${secs}s — ${written} finding(s) written:`);
  for (const f of findings) {
    console.log(`  [${f.kind}] ${f.conceptSlugs.join(', ')} — ${f.message}`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
