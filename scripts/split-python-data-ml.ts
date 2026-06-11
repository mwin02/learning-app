// Phase 2.5d-4: retag the existing DB for the python-data-ml → {python,
// machine-learning, python-data-ml} 3-way split.
//
//   npx tsx --env-file=.env.local scripts/split-python-data-ml.ts
//
// The DURABLE fix is in data/seed-resources.ts (the seed container rows now carry
// the right topic, and decomposition makes children inherit it). This script
// migrates a dev DB that was already seeded + decomposed under the old conflated
// `python-data-ml` topic: it moves each affected seed container AND its whole
// decomposed subtree to the new topic. Idempotent — re-running is a no-op once
// the rows already carry the target topic.
//
// `topic` is not part of the embedding text (title + summary + conceptsTaught),
// so no re-embed is needed; updatedAt is deliberately left untouched to avoid
// marking rows embed-stale.

import { prisma } from '../src/lib/db';

// seed slug → the topic its subtree should move to. Resources not listed
// (numpy, pandas, matplotlib, scikit-learn) stay `python-data-ml`.
const MOVES: { slug: string; topic: string }[] = [
  { slug: 'python-data-ml-python-official-tutorial', topic: 'python' },
  { slug: 'python-data-ml-fcc-python-mike-dane', topic: 'python' },
  { slug: 'python-data-ml-corey-schafer-python-tutorials', topic: 'python' },
  { slug: 'python-data-ml-automate-boring-stuff', topic: 'python' },
  { slug: 'python-data-ml-statquest-ml-fundamentals', topic: 'machine-learning' },
];

async function main() {
  for (const { slug, topic } of MOVES) {
    // Update the seed row + its whole decomposed subtree (any nesting depth).
    const n = await prisma.$executeRaw`
      WITH RECURSIVE subtree AS (
        SELECT id FROM "Resource" WHERE slug = ${slug}
        UNION ALL
        SELECT c.id FROM "Resource" c JOIN subtree s ON c."parentResourceId" = s.id
      )
      UPDATE "Resource" SET topic = ${topic}
      WHERE id IN (SELECT id FROM subtree) AND topic IS DISTINCT FROM ${topic}
    `;
    console.log(`[split] ${slug.padEnd(46)} -> ${topic.padEnd(16)} ${n} row(s)`);
  }

  console.log('\n[split] active atomic counts after:');
  for (const topic of ['python', 'python-data-ml', 'machine-learning']) {
    const n = await prisma.resource.count({
      where: { topic, status: 'active', decompositionStatus: 'atomic' },
    });
    console.log(`   ${topic.padEnd(16)} ${n}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
