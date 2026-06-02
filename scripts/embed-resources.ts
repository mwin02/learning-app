// Phase 2.5-AR (AR-1): one-shot backfill / re-embed of Resource embeddings.
//
//   npx tsx --env-file=.env.local scripts/embed-resources.ts
//
// Embeds every row that is missing an embedding or whose content changed since
// it was last embedded (embeddedAt < updatedAt). Idempotent: re-running with
// nothing stale is a no-op. The actual work lives in embedMissing() so the
// seed and this script stay in lockstep.

import { prisma } from '../src/lib/db';
import { embedMissing } from '../src/lib/ai/embeddings';

async function main() {
  const start = Date.now();
  const embedded = await embedMissing();
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`embed-resources: embedded ${embedded} resource(s) in ${secs}s`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
