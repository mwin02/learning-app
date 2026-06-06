// Maintenance: deepen an already-`decomposed` container whose children are
// themselves containers (the pre-recursion single-layer decompose left them as
// atomic leaves — e.g. a path exploded into its courses, but each course was
// kept whole instead of drilled into its lessons).
//
// For each existing ATOMIC child of the given root, we re-run the doc-TOC router
// directly on the child's URL (bypassing classify(), whose only signal is the
// child's stored type='article' — which would mis-route a real container back to
// atomic). If the child comes back a lesson_sequence we flip it to 'decomposed'
// via decomposeExisting(), which updates its status and materializes its subtree
// beneath it. Nothing is deleted: the child row stays, gains children, and stops
// being pickable in favor of its new leaves. Idempotent on re-run (existing
// child URLs are skipped by createChild's clash guard).
//
// YouTube-playlist children are single videos (genuinely atomic) and are left
// alone — this only deepens doc/course trees.
//
// Run (preview, no writes):  npx tsx --env-file=.env.local scripts/deepen-decomposition.ts <resourceId> --dry-run
// Run (apply):               npx tsx --env-file=.env.local scripts/deepen-decomposition.ts <resourceId>
// Add --force to bypass the per-node / total-node oversize gates for a large
// curated tree.

import { prisma } from '../src/lib/db';
import { decomposeDocToc } from '../src/lib/agents/decomposition/doctoc';
import { decomposeExisting } from '../src/lib/agents/decomposition/upsert-resource';
import { DECOMPOSITION_MAX_DEPTH, DECOMPOSITION_MAX_TOTAL_NODES } from '../src/lib/config';

function countTree(children: { children?: unknown[] }[]): number {
  let n = 0;
  for (const c of children) {
    n += 1;
    if (Array.isArray(c.children)) n += countTree(c.children as { children?: unknown[] }[]);
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const rootId = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  if (!rootId) {
    console.error('usage: deepen-decomposition.ts <resourceId> [--dry-run] [--force]');
    process.exit(1);
  }

  const root = await prisma.resource.findUnique({
    where: { id: rootId },
    select: { id: true, title: true, decompositionStatus: true },
  });
  if (!root) {
    console.error(`resource ${rootId} not found`);
    process.exit(1);
  }
  if (root.decompositionStatus !== 'decomposed') {
    console.error(`resource is '${root.decompositionStatus}', not 'decomposed' — nothing to deepen`);
    process.exit(1);
  }

  const children = await prisma.resource.findMany({
    where: { parentResourceId: root.id, decompositionStatus: 'atomic' },
    select: {
      id: true,
      url: true,
      title: true,
      topic: true,
      difficulty: true,
      conceptsTaught: true,
    },
    orderBy: { orderInParent: 'asc' },
  });

  console.log(`Root: ${root.title}`);
  console.log(`Atomic children to evaluate: ${children.length}${dryRun ? '  (DRY RUN)' : ''}\n`);

  let deepened = 0;
  let created = 0;

  for (const child of children) {
    const result = await decomposeDocToc({
      url: child.url,
      topic: child.topic,
      difficulty: child.difficulty,
      parentConcepts: child.conceptsTaught,
      force,
      depth: 0,
      maxDepth: DECOMPOSITION_MAX_DEPTH,
      visited: new Set([root.id, child.url]),
      budget: { remaining: force ? Number.POSITIVE_INFINITY : DECOMPOSITION_MAX_TOTAL_NODES },
    });

    if (!result.ok) {
      console.log(`  · leaf   ${child.title}  (${result.outcome}: ${result.reason})`);
      continue;
    }

    const subtree = countTree(result.children);
    console.log(`  ↳ DEEPEN ${child.title}  → ${result.children.length} sections (${subtree} nodes in subtree)`);
    deepened += 1;

    if (!dryRun) {
      const { childrenCreated } = await decomposeExisting(child.id, {
        status: 'decomposed',
        children: result.children,
      });
      created += childrenCreated;
      console.log(`           created ${childrenCreated} descendant rows`);
    }
  }

  console.log(`\nDone. ${deepened} child(ren) deepened${dryRun ? ' (preview)' : `, ${created} rows created`}.`);
}

main().finally(() => process.exit(0));
