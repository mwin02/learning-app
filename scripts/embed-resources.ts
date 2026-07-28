// Phase 2.5-AR (AR-1): one-shot backfill / re-embed of Resource embeddings.
//
//   npx tsx --env-file=.env.local scripts/embed-resources.ts
//
// Embeds every row that is missing an embedding or whose content changed since
// it was last embedded (embeddedAt < updatedAt). Idempotent: re-running with
// nothing stale is a no-op. The actual work lives in embedMissing() so the
// seed and this script stay in lockstep.
//
// Topic filing T2a: also refreshes the TopicCentroid table afterwards — centroids are
// means over these very embeddings, so recomputing them anywhere else would let the
// guardrail's pre-filter drift behind the corpus it summarizes. Pure SQL, no LLM spend.

import { prisma } from '../src/lib/db';
import { embedMissing } from '../src/lib/ai/embeddings';
import { refreshTopicCentroids } from '../src/lib/curation/topic-centroids';

async function main() {
  const start = Date.now();
  const embedded = await embedMissing();
  const { topics, removed } = await refreshTopicCentroids();
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `embed-resources: embedded ${embedded} resource(s), refreshed ${topics} topic centroid(s)` +
      `${removed ? `, removed ${removed} stale` : ''} in ${secs}s`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
