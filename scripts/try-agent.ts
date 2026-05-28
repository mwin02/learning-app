// Throwaway driver for the curriculum agent. Not wired into any route.
// Run: `npx tsx --env-file=.env.local scripts/try-agent.ts [--topic <slug>] [--fresh]`
//   --topic   topic slug to plan for (default: python-data-ml). Pass an
//             off-library topic (go, statistics, machine-learning) to exercise
//             the 2c web fallback.
//   --fresh   delete origin='agent' rows for the topic before running, so
//             cache-back behavior is observable on a repeat invocation.

import { generateCurriculum } from '@/lib/curriculum-agent';
import { prisma } from '@/lib/db';

function parseArgs(argv: string[]): { topic: string; fresh: boolean } {
  let topic = 'python-data-ml';
  let fresh = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--topic' && argv[i + 1]) {
      topic = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--fresh') {
      fresh = true;
    }
  }
  return { topic, fresh };
}

async function main() {
  const { topic, fresh } = parseArgs(process.argv.slice(2));

  if (fresh) {
    const deleted = await prisma.resource.deleteMany({ where: { topic, origin: 'agent' } });
    console.log(`[try-agent] --fresh: deleted ${deleted.count} agent-origin rows for topic '${topic}'`);
  }

  const input = {
    topic,
    difficulty: 'beginner' as const,
    priorKnowledge: 'have JavaScript experience but new to this topic',
    timeframeWeeks: 6,
    hoursPerWeek: 5,
  };

  console.log('Input:', JSON.stringify(input, null, 2));
  const result = await generateCurriculum(input);
  console.log('\nResult:');
  console.log(JSON.stringify(result, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
