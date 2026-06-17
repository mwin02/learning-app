// Phase 2.5f-6: manual driver for on-demand frontier-concept enrichment.
//
//   npx tsx --env-file=.env.local scripts/add-frontier.ts <topic|pathId> "<free text concept>"
//
// Adds a learner-requested specialized concept to a Path's map as a FRONTIER node
// (dedup + relevance-gated), wired into the DAG and resourced. Frontier concepts
// don't gate `spine_ready`, so this is purely additive. The user-facing request
// trigger is deferred to the request layer (2.5g); this is the manual invoker.

import { prisma } from '../src/lib/db';
import { addFrontierConcept } from '../src/lib/agents/track/add-frontier-concept';

async function main() {
  const [target, ...rest] = process.argv.slice(2);
  const request = rest.join(' ').trim();
  if (!target || !request) {
    console.error('Usage: tsx --env-file=.env.local scripts/add-frontier.ts <topic|pathId> "<free text concept>"');
    process.exit(1);
  }

  const byTopic = await prisma.path.findUnique({ where: { topic: target }, select: { id: true, topic: true } });
  const path = byTopic ?? (await prisma.path.findUnique({ where: { id: target }, select: { id: true, topic: true } }));
  if (!path) {
    console.error(`No Path found for topic or id '${target}'.`);
    process.exit(1);
  }

  console.log(`[add-frontier] ${path.topic} (${path.id}) <- "${request}"`);
  const start = Date.now();
  const result = await addFrontierConcept({ pathId: path.id, request });
  console.log(`[add-frontier] done in ${((Date.now() - start) / 1000).toFixed(1)}s:`, result);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
