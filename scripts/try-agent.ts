// Throwaway driver for the curriculum agent. Not wired into any route.
// Run: `npx tsx --env-file=.env.local scripts/try-agent.ts [--topic <slug>] [--fresh] [--via-http] [--weeks N] [--hours N]`
//   --topic     topic slug to plan for (default: python-data-ml). Pass an
//               off-library topic (go, statistics, machine-learning) to exercise
//               the 2c web fallback.
//   --fresh     delete origin='agent' rows for the topic before running, so
//               cache-back behavior is observable on a repeat invocation.
//   --weeks N   timeframe in weeks (default 6).
//   --hours N   hours per week (default 5). A tight budget (--weeks 1 --hours 1)
//               forces a critic budget-fit failure so the AR-6 revise loop fires;
//               watch the `[curriculum-agent] critic` logs for the verdict.
//   --via-http  POST to the local /api/generate-path route instead of calling
//               generateCurriculum directly. Requires `npm run dev` running
//               with DEV_AUTH=1 in the env (the route's auth gate; see
//               src/lib/api/with-auth.ts). Port via $PORT (default 3000).

import { generateCurriculum } from '@/lib/curriculum-agent';
import { prisma } from '@/lib/db';

type Args = {
  topic: string;
  fresh: boolean;
  viaHttp: boolean;
  weeks: number;
  hours: number;
};

function parseArgs(argv: string[]): Args {
  let topic = 'python-data-ml';
  let fresh = false;
  let viaHttp = false;
  // Defaults give a roomy budget (30h) so a clean path usually passes the
  // critic on the first try. Pass a tight budget (e.g. --weeks 1 --hours 1) to
  // force a budget-fit failure and watch the bounded revise loop fire.
  let weeks = 6;
  let hours = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--topic' && argv[i + 1]) {
      topic = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--fresh') {
      fresh = true;
    } else if (argv[i] === '--via-http') {
      viaHttp = true;
    } else if (argv[i] === '--weeks' && argv[i + 1]) {
      weeks = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--hours' && argv[i + 1]) {
      hours = Number(argv[i + 1]);
      i += 1;
    }
  }
  return { topic, fresh, viaHttp, weeks, hours };
}

async function main() {
  const { topic, fresh, viaHttp, weeks, hours } = parseArgs(process.argv.slice(2));

  if (fresh) {
    const deleted = await prisma.resource.deleteMany({ where: { topic, origin: 'agent' } });
    console.log(`[try-agent] --fresh: deleted ${deleted.count} agent-origin rows for topic '${topic}'`);
  }

  const input = {
    topic,
    difficulty: 'beginner' as const,
    priorKnowledge: 'have JavaScript experience but new to this topic',
    timeframeWeeks: weeks,
    hoursPerWeek: hours,
  };

  console.log('Input:', JSON.stringify(input, null, 2));

  if (viaHttp) {
    const port = process.env.PORT ?? '3000';
    const url = `http://localhost:${port}/api/generate-path`;
    console.log(`POST ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.text();
    console.log(`\nStatus: ${res.status}`);
    console.log('Body:', body);
    if (!res.ok) process.exit(1);
    return;
  }

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
