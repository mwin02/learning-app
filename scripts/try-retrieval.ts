// Throwaway driver for AR-3 retrieval loop. Not wired into any route.
// Run: `npx tsx --env-file=.env.local scripts/try-retrieval.ts [--topic <slug>] [--difficulty <d>] [--prior "<text>"]`
//   --topic       topic slug (default: python-data-ml). Try an off-library
//                 topic (go, statistics) to exercise the floor + fallback tool.
//   --difficulty  beginner | intermediate | advanced (default: beginner)
//   --prior       prior-knowledge free text (optional)

import { runRetrieval } from '@/lib/agents/curriculum/curriculum-retrieval';
import type { CurriculumInput } from '@/lib/agents/curriculum/curriculum-agent';
import type { Difficulty } from '@prisma/client';
import { prisma } from '@/lib/db';

function parseArgs(argv: string[]): CurriculumInput {
  let topic = 'python-data-ml';
  let difficulty: Difficulty = 'beginner';
  let priorKnowledge: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--topic' && argv[i + 1]) topic = argv[++i];
    else if (argv[i] === '--difficulty' && argv[i + 1]) difficulty = argv[++i] as Difficulty;
    else if (argv[i] === '--prior' && argv[i + 1]) priorKnowledge = argv[++i];
  }
  return { topic, difficulty, priorKnowledge, timeframeWeeks: 4, hoursPerWeek: 5 };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  console.log('input:', input, '\n');

  const r = await runRetrieval(input);

  console.log(`\n== gathered ${r.candidates.length} candidates in ${r.steps} step(s), ${r.fallbackCalls} fallback call(s) ==`);
  for (const c of r.candidates) {
    const dist = c.distance === null ? '  —  ' : c.distance.toFixed(4);
    console.log(`  ${c.handle.padEnd(4)} [${dist}] (${c.difficulty}) ${c.title}`);
  }
  console.log('\nmodel notes:', r.notes || '(none)');

  // Sanity-check the opaque-handle round trip: every handle resolves to a row
  // carrying a real id, and an unknown handle resolves to undefined.
  const first = r.candidates[0]?.handle;
  if (first) console.log(`\nresolve(${first}) -> id`, r.resolve(first)?.id);
  console.log('resolve("r9999") ->', r.resolve('r9999'));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
