// M3 of `pro-to-flash.md`: does `curriculumFallback` (grounded discovery) hold its
// yield on Flash? Replays rung 1 per concept — discoverForConceptScoped (oversample 6,
// empty deny list, the DB's allowlist), then the production validators, then the
// candidate judge — all in memory. Nothing is persisted; the script checks that the
// Resource, ConceptResource and ResourceTopic row counts are unchanged at the end.
//
// Production run (the real comparison; baseline × 2, pilot, projection, then the ladder):
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/compare-discovery-models.ts
//
// Smoke run (1 input, baseline once + flash-low once, no pilot/projection/ladder),
// against whatever DATABASE_URL points at — the local dev DB when run directly:
//   npx tsx --env-file=.env.local scripts/compare-discovery-models.ts --smoke
//
// Both charge real spend to the `discovery` allotment in the ledger
// (docs/audits/pro-to-flash/ledger.json) and refuse an input that would cross it.
// Results append to docs/audits/pro-to-flash/discovery.jsonl (discovery-smoke.jsonl).

import { prisma } from '../src/lib/db';
import { discoverForConceptScoped, loadAllowlistDomains } from '../src/lib/agents/tools/web-fallback';
import { runValidationPipeline } from '../src/lib/agents/validation';
import { livenessValidator } from '../src/lib/agents/validation/validators/liveness';
import { rulesAgentValidator } from '../src/lib/agents/validation/validators/rules-agent';
import { judgeCandidates } from '../src/lib/agents/map/candidate-judge';
import type { SearchResult } from '../src/lib/agents/tools/search-resources';
import { MAP_ATTACH_MIN_COVERAGE, REMEDIATION_DISCOVERY_OVERSAMPLE } from '../src/lib/config';
import { pricePointOn, type ArmName } from '../src/lib/ai/model-compare';
import {
  discoveryBars,
  meanMetrics,
  summarizeRun,
  walkLadder,
  type DiscoveryInputResult,
  type DiscoveryRunMetrics,
  type Verdict,
} from '../src/lib/ai/discovery-compare';
import { appendResult, BudgetRefusedError, formatLedger, projectRun, runArm } from './model-compare-harness';

type Input = { topic: string; slug: string; conceptTitle: string; isOnRamp: boolean };

// Fixed before any run (the plan's rule: inputs can't be picked to fit a result).
// Order matters: the first PILOT_INPUTS are the pilot, and a shrunk run keeps a prefix.
const INPUTS: readonly Input[] = [
  // The four thicken concepts of production request cmuro8iil000301s6fy7bj5fq
  // (operating-systems, 2026-10-03; `track.thicken.concept` lines in Cloud Logging).
  { topic: 'operating-systems', slug: 'io-systems', conceptTitle: 'I/O Systems', isOnRamp: false },
  { topic: 'python-data-ml', slug: 'data-manipulation-pandas', conceptTitle: 'Data Manipulation and Analysis with Pandas', isOnRamp: false },
  { topic: 'operating-systems', slug: 'mass-storage-management', conceptTitle: 'Mass-Storage Management', isOnRamp: false },
  { topic: 'javascript-react', slug: 'side-effects-with-useeffect', conceptTitle: 'Handling Side Effects with the useEffect Hook', isOnRamp: false },
  { topic: 'operating-systems', slug: 'protection', conceptTitle: 'Protection', isOnRamp: false },
  { topic: 'calculus', slug: 'fundamental-theorem-of-calculus', conceptTitle: 'The Fundamental Theorem of Calculus', isOnRamp: false },
  { topic: 'operating-systems', slug: 'introduction-to-operating-systems', conceptTitle: 'Introduction to Operating Systems', isOnRamp: true },
  { topic: 'linear-algebra', slug: 'eigenvalues-and-eigenvectors', conceptTitle: 'Eigenvalues and Eigenvectors', isOnRamp: false },
  { topic: 'operating-systems', slug: 'virtual-memory', conceptTitle: 'Virtual Memory', isOnRamp: false },
  { topic: 'python-data-ml', slug: 'model-evaluation-and-selection', conceptTitle: 'Model Evaluation and Selection', isOnRamp: false },
];

const TARGET_INPUTS = 10;
const MINIMUM_INPUTS = 8;
const PILOT_INPUTS = 2;
// Admission estimate for an arm's inputs before its pilot has measured one. Above a
// Pro call's expected cost (a few grounding queries plus tokens), so a near-full
// allotment refuses rather than overshoots.
const UNPILOTED_PROJECTED_USD = 0.3;
const PROJECTION_HEADROOM = 1.5;

// curriculumFallback's baseline is already Pro at `low`, so `pro-low` is not a
// candidate here (the plan reserves it for banks and the composer).
const DISCOVERY_LADDER = ['flash-low', 'flash-default'] as const satisfies readonly ArmName[];

// Mirrors web-fallback.ts's private VALIDATORS; keep in lockstep.
const VALIDATORS = [livenessValidator, rulesAgentValidator];

type Measured = DiscoveryInputResult & { quarantined: number; rejected: number };
type Row = { input: Input; result: DiscoveryInputResult; chargedUsd: number };
type Discovered = Awaited<ReturnType<typeof discoverForConceptScoped>>[number];

function asSearchResult(row: Discovered, i: number, topic: string): SearchResult {
  return {
    id: `candidate-${i}`,
    slug: `candidate-${i}`,
    topic,
    title: row.title,
    url: row.url,
    type: row.type,
    tier: 'free',
    difficulty: row.difficulty,
    durationMin: row.durationMin ?? null,
    summary: row.summary,
    prerequisiteConcepts: row.rawPrerequisiteConcepts,
    conceptsTaught: row.rawConceptsTaught,
    requiresPurchase: false,
    trustScore: 0,
    decompositionStatus: 'atomic',
    distance: null,
  };
}

async function replayRung1(input: Input, allowDomains: string[]): Promise<Omit<Measured, 'discoveryCalls'>> {
  const rows = await discoverForConceptScoped(input.topic, input.conceptTitle, REMEDIATION_DISCOVERY_OVERSAMPLE, [], allowDomains);
  const { valid, quarantined, rejected } = await runValidationPipeline<Discovered>(rows, VALIDATORS);
  const judged = await judgeCandidates({
    conceptTitle: input.conceptTitle,
    conceptSlug: input.slug,
    candidates: valid.map((row, i) => asSearchResult(row, i, input.topic)),
    isOnRamp: input.isOnRamp,
  });
  // A `teaches` verdict counts only at a coverage that would actually attach.
  const teaches = judged.filter((j) => j.role === 'teaches' && j.coverageScore >= MAP_ATTACH_MIN_COVERAGE).length;
  return { attested: rows.length, survivors: valid.length, teaches, quarantined: quarantined.length, rejected: rejected.length };
}

async function runInputs(args: {
  arm: ArmName;
  run: number;
  inputs: readonly Input[];
  projectedUsd: number;
  allowDomains: string[];
  resultsFile: string;
}): Promise<Row[]> {
  const rows: Row[] = [];
  for (const input of args.inputs) {
    const label = `${args.arm}#${args.run} ${input.topic}::${input.slug}`;
    try {
      const run = await runArm({
        driver: 'discovery',
        agent: 'curriculumFallback',
        arm: args.arm,
        projectedUsd: args.projectedUsd,
        fn: () => replayRung1(input, args.allowDomains),
      });
      const discoveryCalls = run.records.filter((r) => r.agent === 'curriculumFallback');
      const { quarantined, rejected, ...counts } = run.value;
      rows.push({ input, result: { ...counts, discoveryCalls }, chargedUsd: run.chargedUsd });
      appendResult(args.resultsFile, { kind: 'input', arm: args.arm, run: args.run, ...input, ...counts, quarantined, rejected, discoveryCalls, cost: run.cost, chargedUsd: run.chargedUsd });
      console.log(`  ${label}: attested ${counts.attested}, survivors ${counts.survivors}, teaches ${counts.teaches}, $${run.chargedUsd.toFixed(4)}`);
    } catch (err) {
      if (err instanceof BudgetRefusedError) throw err;
      // Spent calls are already charged by runArm. The input is scored as zero
      // yield and counted under `errors`, so a flaky arm can't look better for it.
      const error = err instanceof Error ? err.message : String(err);
      console.error(`  ${label}: ERROR ${error}`);
      rows.push({ input, result: { attested: 0, survivors: 0, teaches: 0, discoveryCalls: [], error }, chargedUsd: 0 });
      appendResult(args.resultsFile, { kind: 'input', arm: args.arm, run: args.run, ...input, error });
    }
  }
  return rows;
}

const perInputUsd = (rows: readonly Row[]) => rows.reduce((sum, r) => sum + r.chargedUsd, 0) / Math.max(1, rows.length);
// An arm's own pilot, with headroom; an arm whose pilot measured nothing keeps the estimate.
function admitFrom(rows: readonly Row[]): number {
  const max = Math.max(0, ...rows.map((r) => r.chargedUsd));
  return max > 0 ? max * PROJECTION_HEADROOM : UNPILOTED_PROJECTED_USD;
}

function printSummary(table: [string, DiscoveryRunMetrics][]): void {
  const usd = (n: number | null) => (n === null ? '-' : `$${n.toFixed(4)}`);
  const num = (n: number | null) => (n === null ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(1));
  console.table(
    Object.fromEntries(
      table.map(([name, m]) => [
        name,
        {
          n: m.inputs,
          'med attested': num(m.medianAttested),
          'med survivors': num(m.medianSurvivors),
          'Σ teaches': num(m.teachesSum),
          'zero-yield': num(m.zeroTeaches),
          'p50 ms': num(m.p50LatencyMs),
          'max ms': num(m.maxLatencyMs),
          'grounding q': num(m.groundingQueries),
          errors: num(m.errors),
          '$/call Pro': usd(m.usdPerCall.pro),
          '$/call Flash intro': usd(m.usdPerCall.flashIntro),
          '$/call Flash 2027': usd(m.usdPerCall.flash2027),
        },
      ]),
    ),
  );
}

function printVerdict(arm: ArmName, metrics: DiscoveryRunMetrics, baseline: DiscoveryRunMetrics, resultsFile: string): Verdict {
  const { bars, verdict, reason } = discoveryBars(metrics, baseline);
  const n = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2));
  console.log(`\nBars — ${arm} vs baseline:`);
  for (const b of bars) console.log(`  ${b.pass ? 'PASS' : 'FAIL'}  ${b.name}: measured ${n(b.measured)} ${b.comparator} threshold ${n(b.threshold)}`);
  console.log(`  verdict: ${arm} ${verdict}${reason ? ` (${reason})` : ''}`);
  if (verdict === 'INCONCLUSIVE') {
    console.log('  The comparison cannot decide: no further arm runs, and M4 must not proceed on this result.');
  }
  appendResult(resultsFile, { kind: 'verdict', arm, verdict, reason, bars, metrics, baseline });
  return verdict;
}

async function rowCounts() {
  const [resource, conceptResource, resourceTopic] = await Promise.all([
    prisma.resource.count(),
    prisma.conceptResource.count(),
    prisma.resourceTopic.count(),
  ]);
  return { resource, conceptResource, resourceTopic };
}

async function compare(smoke: boolean): Promise<void> {
  const resultsFile = smoke ? 'discovery-smoke' : 'discovery';
  const allowDomains = await loadAllowlistDomains();
  if (allowDomains.length === 0) throw new Error('no allowlisted Source domains; rung 1 would return nothing');
  console.log(`${smoke ? 'SMOKE' : 'FULL'} run: ${allowDomains.length} allowlisted domains, price point ${pricePointOn(new Date())}`);
  console.log(formatLedger());
  const common = { allowDomains, resultsFile };

  if (smoke) {
    const inputs = INPUTS.slice(0, 1);
    const b = await runInputs({ ...common, arm: 'baseline', run: 1, inputs, projectedUsd: UNPILOTED_PROJECTED_USD });
    const f = await runInputs({ ...common, arm: 'flash-low', run: 1, inputs, projectedUsd: UNPILOTED_PROJECTED_USD });
    const baseline = summarizeRun(b.map((r) => r.result));
    const flashLow = summarizeRun(f.map((r) => r.result));
    printSummary([['baseline', baseline], ['flash-low', flashLow]]);
    console.log('\nSMOKE: n=1 and one baseline run — the bars below are meaningless, printed only to exercise the output.');
    printVerdict('flash-low', flashLow, baseline, resultsFile);
  } else {
    const pilot = INPUTS.slice(0, PILOT_INPUTS);
    console.log(`\nPilot: ${PILOT_INPUTS} inputs, baseline ×2 and flash-low`);
    const b1 = await runInputs({ ...common, arm: 'baseline', run: 1, inputs: pilot, projectedUsd: UNPILOTED_PROJECTED_USD });
    const b2 = await runInputs({ ...common, arm: 'baseline', run: 2, inputs: pilot, projectedUsd: UNPILOTED_PROJECTED_USD });
    const fl = await runInputs({ ...common, arm: 'flash-low', run: 1, inputs: pilot, projectedUsd: UNPILOTED_PROJECTED_USD });

    // The pilot inputs are the first of the full set, so the projection covers only the rest.
    const projection = projectRun({
      driver: 'discovery',
      costPerInputByArmRun: [perInputUsd(b1), perInputUsd(b2), perInputUsd(fl)],
      target: TARGET_INPUTS - PILOT_INPUTS,
      minimum: MINIMUM_INPUTS - PILOT_INPUTS,
    });
    const total = PILOT_INPUTS + projection.inputs;
    console.log(`\nProjection: ${projection.kind}, ${total} of ${TARGET_INPUTS} inputs fit (minimum ${MINIMUM_INPUTS}). ${formatLedger()}`);
    if (projection.kind === 'below-minimum') {
      console.log('STOP: the discovery allotment cannot reach the minimum input count; the full comparison was not run.');
      return;
    }
    const rest = INPUTS.slice(PILOT_INPUTS, total);

    console.log('\nBaseline ×2 over the remaining inputs');
    b1.push(...(await runInputs({ ...common, arm: 'baseline', run: 1, inputs: rest, projectedUsd: admitFrom(b1) })));
    b2.push(...(await runInputs({ ...common, arm: 'baseline', run: 2, inputs: rest, projectedUsd: admitFrom(b2) })));
    const run1 = summarizeRun(b1.map((r) => r.result));
    const run2 = summarizeRun(b2.map((r) => r.result));
    const baseline = meanMetrics([run1, run2]);
    const table: [string, DiscoveryRunMetrics][] = [['baseline run 1', run1], ['baseline run 2', run2], ['baseline (mean)', baseline]];

    await walkLadder(DISCOVERY_LADDER, async (arm) => {
      console.log(`\nArm ${arm}`);
      let rows = fl;
      if (arm !== 'flash-low') {
        rows = await runInputs({ ...common, arm, run: 1, inputs: pilot, projectedUsd: UNPILOTED_PROJECTED_USD });
        const fits = projectRun({ driver: 'discovery', costPerInputByArmRun: [perInputUsd(rows)], target: rest.length, minimum: rest.length });
        if (fits.kind !== 'fits') {
          throw new BudgetRefusedError(`refused: ${arm} needs ${rest.length} more inputs to match the baseline and the allotment covers ${fits.inputs}`);
        }
      }
      rows.push(...(await runInputs({ ...common, arm, run: 1, inputs: rest, projectedUsd: admitFrom(rows) })));
      const metrics = summarizeRun(rows.map((r) => r.result));
      table.push([arm, metrics]);
      printSummary(table);
      return { verdict: printVerdict(arm, metrics, baseline, resultsFile), result: metrics };
    });
  }

}

async function main(): Promise<void> {
  const before = await rowCounts();
  try {
    await compare(process.argv.includes('--smoke'));
  } catch (err) {
    if (!(err instanceof BudgetRefusedError)) throw err;
    console.error(`\nSTOP: ${err.message}`);
    process.exitCode = 2;
  } finally {
    const after = await rowCounts();
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(`\nRow counts ${unchanged ? 'unchanged' : 'CHANGED'}: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    console.log(formatLedger());
    if (!unchanged) process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
