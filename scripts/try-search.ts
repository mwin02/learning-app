// Throwaway driver for AR-2 hybrid search. Not wired into any route.
// Run: `npx tsx --env-file=.env.local scripts/try-search.ts [--topic <slug>] [--q <query>] [--limit <n>]`
//   --topic   restrict to a topic slug (default: python-data-ml)
//   --q       free-text query to rank by (default: "neural networks and backpropagation")
//   --limit   max ranked results (default: 5)
//   --all     drop the topic filter (search the whole library)

import { searchResources } from '@/lib/search-resources';
import { SEARCH_RANK_THRESHOLD } from '@/lib/config';
import { prisma } from '@/lib/db';

type Args = { topic?: string; q: string; limit: number };

function parseArgs(argv: string[]): Args {
  let topic: string | undefined = 'python-data-ml';
  let q = 'neural networks and backpropagation';
  let limit = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--topic' && argv[i + 1]) (topic = argv[++i]);
    else if (argv[i] === '--q' && argv[i + 1]) (q = argv[++i]);
    else if (argv[i] === '--limit' && argv[i + 1]) (limit = Number(argv[++i]));
    else if (argv[i] === '--all') topic = undefined;
  }
  return { topic, q, limit };
}

async function main() {
  const { topic, q, limit } = parseArgs(process.argv.slice(2));
  console.log(`query=${JSON.stringify(q)} topic=${topic ?? '(all)'} limit=${limit} rankThreshold=${SEARCH_RANK_THRESHOLD}`);

  const results = await searchResources({ query: q, topic, limit });
  const ranked = results.some((r) => r.distance !== null);
  console.log(`-> ${results.length} results (${ranked ? 'RANKED by similarity' : 'fast-path / trustScore'})\n`);
  for (const r of results) {
    const dist = r.distance === null ? '   —  ' : r.distance.toFixed(4);
    console.log(`  [${dist}] (${r.difficulty}) ${r.title}`);
    console.log(`           teaches: ${r.conceptsTaught.slice(0, 6).join(', ')}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
