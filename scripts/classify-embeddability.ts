// Phase 2.5j-2: one-shot backfill of Resource.embeddable for the existing library.
//
//   npx tsx --env-file=.env.local scripts/classify-embeddability.ts
//
// Probes every un-probed pickable (atomic, non-generated) resource for frame
// embeddability and caches the verdict on Resource — so already-built and
// future Tracks can render embeds instead of the conservative newtab default.
// Idempotent: targets `embedCheckedAt IS NULL`, so a re-run only retries the
// rows that stayed inconclusive. The work lives in backfillEmbeddability() so
// the insert path and this script stay in lockstep.

import { prisma } from '../src/lib/db';
import { backfillEmbeddability } from '../src/lib/curation/embeddability';

async function main() {
  const start = Date.now();
  const { embed, newtab, inconclusive } = await backfillEmbeddability();
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `classify-embeddability: ${embed} embed, ${newtab} newtab, ${inconclusive} inconclusive in ${secs}s`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
