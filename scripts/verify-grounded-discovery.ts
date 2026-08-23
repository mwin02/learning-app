// Live driver for grounding attestation (fix/grounded-discovery-attestation).
//
//   npx tsx --env-file=.env.local scripts/verify-grounded-discovery.ts
//   npx tsx --env-file=.env.local scripts/verify-grounded-discovery.ts --concept "paging" --topic "operating systems"
//
// READ-ONLY against the DB — it calls the two discovery prongs directly and never
// persists. It DOES spend LLM calls (one Pro grounded call + one Flash describe
// call per case) and one HTTP request per discovered URL.
//
// WHAT IT MEASURES, and why a unit test cannot. The property is "a real grounded
// call no longer returns URLs that don't exist", which needs a real model, a real
// search, and a real fetch of each result. So this stays a manual driver per
// `.claude/rules/testing.md`; the pure halves (the index join, the redirect
// resolution) are covered by the colocated unit tests.
//
// READ THE OUTPUT AS: `dead` on a discovered URL is the defect this branch exists
// to remove. Before the change, a run over these same concepts returned ~60% dead
// ocw.mit.edu URLs (measured against production rows, 2026-08-23). `unreachable`
// is not a defect — a slow host is indistinguishable from a dead one at 12s, which
// is why the liveness validator quarantines rather than rejects on it. `blocked`
// (401/403/429) is a bot wall: the host refused us, which is not evidence about
// whether the URL exists.

import { discoverForConcept, discoverForConceptScoped } from '../src/lib/agents/tools/web-fallback';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

type Verdict = 'ok' | 'dead' | 'blocked' | 'unreachable';

async function liveness(url: string): Promise<{ verdict: Verdict; detail: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (res.ok) return { verdict: 'ok', detail: String(res.status) };
    // A bot wall is the host refusing US, not the page being absent — it says
    // nothing about whether the URL was invented, which is what this driver
    // measures. (The liveness validator does reject these outright; that is a
    // separate, pre-existing question about admission, not about fabrication.)
    return res.status === 401 || res.status === 403 || res.status === 429
      ? { verdict: 'blocked', detail: `http ${res.status}` }
      : { verdict: 'dead', detail: `http ${res.status}` };
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    const message = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
    // ocw.mit.edu answers a nonexistent path with a redirect loop rather than a
    // 404 — the shape that made 52 fabricated OCW URLs look merely slow.
    return /redirect count exceeded/i.test(message)
      ? { verdict: 'dead', detail: 'redirect loop' }
      : { verdict: 'unreachable', detail: message.slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

// The two hosts the fabrications concentrated on, and the ones whose URL grammar
// is guessable enough that a model can pattern-complete a plausible dead slug.
const ALLOW_DOMAINS = ['ocw.mit.edu', 'khanacademy.org', 'docs.python.org', 'developer.mozilla.org'];

const DEFAULT_CASES = [
  { topic: 'operating systems', concept: 'virtual memory' },
  { topic: 'operating systems', concept: 'file systems' },
  { topic: 'computer networks', concept: 'data link protocols' },
];

async function runCase(topic: string, concept: string, rung: 'scoped' | 'open') {
  const label = `${rung} rung — ${topic} :: ${concept}`;
  console.log(`\n=== ${label}`);
  const rows =
    rung === 'scoped'
      ? await discoverForConceptScoped(topic, concept, 6, [], ALLOW_DOMAINS)
      : await discoverForConcept(topic, concept, 6, []);

  if (rows.length === 0) {
    console.log('   (no rows — an empty return is a valid outcome, not a failure)');
    return { discovered: 0, ok: 0, dead: 0, blocked: 0, unreachable: 0 };
  }

  const tally = { discovered: rows.length, ok: 0, dead: 0, blocked: 0, unreachable: 0 };
  for (const row of rows) {
    const { verdict, detail } = await liveness(row.url);
    tally[verdict] += 1;
    console.log(`   ${verdict.padEnd(11)} ${detail.padEnd(14)} ${row.url}`);
  }
  return tally;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const concept = arg('concept');
  const topic = arg('topic');
  const cases = concept && topic ? [{ topic, concept }] : DEFAULT_CASES;

  const totals = { discovered: 0, ok: 0, dead: 0, blocked: 0, unreachable: 0 };
  for (const c of cases) {
    for (const rung of ['scoped', 'open'] as const) {
      const t = await runCase(c.topic, c.concept, rung);
      totals.discovered += t.discovered;
      totals.ok += t.ok;
      totals.dead += t.dead;
      totals.blocked += t.blocked;
      totals.unreachable += t.unreachable;
    }
  }

  console.log('\n=== TOTALS', totals);
  console.log(
    totals.dead === 0
      ? 'PASS — every discovered URL resolved to a live page.'
      : `FAIL — ${totals.dead}/${totals.discovered} discovered URLs are dead.`,
  );
}

main();
