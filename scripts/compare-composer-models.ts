// M7 of `pro-to-flash.md`: does `trackComposer` hold its composition on Flash? Per
// composition (one Path × one synthetic learner scenario) it calls composeTrack over
// the Path's loaded map, then validateComposition single-pass, and stops there: no
// thicken, freeze or section. Nothing is persisted; the script checks that the Track
// and Lesson row counts are unchanged at the end.
//
// Production run (pilot, projection, baseline × 2, then the ladder; writes the side-by-side):
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/compare-composer-models.ts
// Smoke run (1 composition, baseline + flash-low, no pilot/projection/ladder), against
// whatever DATABASE_URL points at — the local dev DB when run directly:
//   npx tsx --env-file=.env.local scripts/compare-composer-models.ts --smoke
// Record the user's side-by-side read of the last completed run (no DB, no model call):
//   npx tsx --env-file=.env.local scripts/compare-composer-models.ts --human-read=pass|fail [--smoke]
//
// Every composer call is charged to the `composer` allotment in the ledger
// (docs/audits/pro-to-flash/ledger.json). Results append to
// docs/audits/pro-to-flash/composer.jsonl (composer-smoke.jsonl); the side-by-side and
// its key go to composer-side-by-side.md and composer-side-by-side-key.json (…-smoke).

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Difficulty, PathStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { loadComposerMap } from '../src/lib/agents/track/build-track';
import { composeTrack } from '../src/lib/agents/track/composer';
import { validateComposition } from '../src/lib/agents/track/validate-composition';
import { budgetMinutesFor } from '../src/lib/agents/track/plan';
import { depthTier } from '../src/lib/agents/track/allocate';
import { LADDER, pricePointOn, type ArmName } from '../src/lib/ai/model-compare';
import { walkLadder, type Verdict } from '../src/lib/ai/discovery-compare';
import { finalVerdict, parseHumanRead, type HumanRead } from '../src/lib/ai/bank-compare';
import {
  composerBars,
  extractRecord,
  lastCompletedRun,
  sideBySide,
  summarizeBaseline,
  summarizeRun,
  type BaselineSummary,
  type ComposerRunMetrics,
  type CompositionOutcome,
  type SideBySideItem,
} from '../src/lib/ai/composer-compare';
import { appendResult, AUDIT_DIR, BudgetRefusedError, formatLedger, projectRun, runArm } from './model-compare-harness';

type Scenario = { label: string; goal: string; priorKnowledge: string | null; targetMastery: Difficulty; timeframeWeeks: number; hoursPerWeek: number };

// Fixed before any run (the plan's rule), looked up read-only in production
// 2026-10-07. operating-systems is the Path of request cmuro8iil000301s6fy7bj5fq.
const PATHS = [
  { id: 'cmsa4k6up00d7atm5h6hh2xwg', topic: 'calculus' },
  { id: 'cmt40gz650000cbm5q09fw3k6', topic: 'operating-systems' },
] as const;

// Synthetic learners, modelled on compare-composers.ts's four (no real goal text).
const SCENARIOS: Record<(typeof PATHS)[number]['topic'], Scenario[]> = {
  calculus: [
    { label: 'exam cram', goal: 'Cram for my calculus exam next week', priorKnowledge: 'Already covered most topics in class', targetMastery: Difficulty.advanced, timeframeWeeks: 1, hoursPerWeek: 4 },
    { label: 'beginner', goal: 'I want to learn calculus', priorKnowledge: 'Basic math knowledge, algebra and geometry', targetMastery: Difficulty.beginner, timeframeWeeks: 3, hoursPerWeek: 5 },
    { label: 'refresh for another course', goal: 'Refresh calculus before a statistics course', priorKnowledge: null, targetMastery: Difficulty.beginner, timeframeWeeks: 4, hoursPerWeek: 5 },
    { label: 'grad refresh', goal: "Refresh calculus before I start my Master's program", priorKnowledge: 'Studied calculus as an undergraduate', targetMastery: Difficulty.intermediate, timeframeWeeks: 3, hoursPerWeek: 3 },
  ],
  'operating-systems': [
    { label: 'exam cram', goal: 'Cram for my operating systems final next week', priorKnowledge: 'Attended most of the lectures this semester', targetMastery: Difficulty.advanced, timeframeWeeks: 1, hoursPerWeek: 4 },
    { label: 'beginner', goal: 'I want to learn how operating systems work', priorKnowledge: 'I can program in Python and a little C, but have never studied systems', targetMastery: Difficulty.beginner, timeframeWeeks: 3, hoursPerWeek: 5 },
    { label: 'refresh for another course', goal: 'Refresh operating systems before a distributed systems course', priorKnowledge: null, targetMastery: Difficulty.beginner, timeframeWeeks: 4, hoursPerWeek: 5 },
    { label: 'grad refresh', goal: "Refresh operating systems before I start my Master's program", priorKnowledge: 'Took an operating systems course as an undergraduate', targetMastery: Difficulty.intermediate, timeframeWeeks: 3, hoursPerWeek: 3 },
  ],
};

type Composition = { id: string; pathId: string; topic: string; scenario: Scenario };

// Scenario-major, so the pilot (first 2) and any shrunk prefix cover both Paths.
const COMPOSITIONS: readonly Composition[] = [0, 1, 2, 3].flatMap((i) =>
  PATHS.map((p) => {
    const scenario = SCENARIOS[p.topic][i];
    return { id: `${p.topic}:${scenario.label.replaceAll(' ', '-')}`, pathId: p.id, topic: p.topic, scenario };
  }),
);

const TARGET_INPUTS = 8;
const MINIMUM_INPUTS = 6;
const PILOT_INPUTS = 2;
const SIDE_BY_SIDE = 4;
// Admission estimate before an arm's pilot has measured a call: above a Pro
// composer call over a ~20-concept map with thinking.
const UNPILOTED_USD = 0.5;
const PROJECTION_HEADROOM = 1.5;

type Loaded = Awaited<ReturnType<typeof loadComposerMap>>;
type Outcome = CompositionOutcome & { chargedUsd: number };
type Ctx = { runId: string; file: string; maps: Map<string, Loaded> };

const admit = (prior: readonly Outcome[]) => {
  const max = Math.max(0, ...prior.map((o) => o.chargedUsd));
  return max > 0 ? max * PROJECTION_HEADROOM : UNPILOTED_USD;
};
const perInputUsd = (outcomes: readonly Outcome[]) => outcomes.reduce((sum, o) => sum + o.chargedUsd, 0) / Math.max(1, outcomes.length);

async function composeOnce(ctx: Ctx, arm: ArmName, run: number, c: Composition, projectedUsd: number): Promise<Outcome> {
  const loaded = ctx.maps.get(c.pathId);
  if (!loaded) throw new Error(`map for ${c.pathId} not loaded`);
  const budgetMinutes = budgetMinutesFor(c.scenario.timeframeWeeks, c.scenario.hoursPerWeek);
  const outcome: Outcome = { compositionId: c.id, record: null, composerCalls: [], chargedUsd: 0 };
  try {
    const result = await runArm({
      driver: 'composer',
      agent: 'trackComposer',
      arm,
      projectedUsd,
      fn: () =>
        composeTrack({
          topic: c.topic,
          concepts: loaded.concepts,
          priorKnowledge: c.scenario.priorKnowledge,
          goal: c.scenario.goal,
          targetMastery: c.scenario.targetMastery,
          budgetMinutes,
          depthTier: depthTier(budgetMinutes, loaded.concepts.length),
        }),
    });
    outcome.composerCalls = result.records.filter((r) => r.agent === 'trackComposer');
    outcome.chargedUsd = result.chargedUsd;
    // Single-pass mode never borrows across concepts, as in build-track.ts.
    const validation = validateComposition({ composition: result.value, concepts: loaded.concepts, edges: loaded.edges, crossConceptResources: false });
    outcome.record = extractRecord(result.value, validation);
  } catch (err) {
    if (err instanceof BudgetRefusedError) throw err;
    // runArm already charged the spent attempts; scored as a failed composition.
    outcome.error = err instanceof Error ? err.message : String(err);
  }
  const { record, error, composerCalls, chargedUsd } = outcome;
  appendResult(ctx.file, { kind: 'composition', runId: ctx.runId, arm, run, compositionId: c.id, record, error, composerCalls, chargedUsd });
  const r = outcome.record;
  console.log(`  ${arm}#${run} ${c.id}: ${r ? `intent ${r.intent}, ${r.lessonConceptSets.length} lessons, ${r.needsThicken ? 'thicken' : 'no thicken'}, ${r.fallbackWarnings} fallback` : `ERROR ${error}`}, $${chargedUsd.toFixed(4)}`);
  return outcome;
}

async function composeAll(ctx: Ctx, arm: ArmName, run: number, comps: readonly Composition[], prior: readonly Outcome[]): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const c of comps) out.push(await composeOnce(ctx, arm, run, c, admit([...prior, ...out])));
  return out;
}

function printSummary(rows: readonly [string, ComposerRunMetrics][], baseline: BaselineSummary): void {
  const pct = (n: number | null) => (n === null ? '-' : `${(100 * n).toFixed(0)}%`);
  const num = (n: number | null) => (n === null ? '-' : n.toFixed(3));
  const usd = (n: number | null) => (n === null ? '-' : `$${n.toFixed(4)}`);
  const ms = (n: number | null) => (n === null ? '-' : String(Math.round(n)));
  console.table(
    Object.fromEntries(
      rows.map(([name, m]) => [
        name,
        {
          n: m.compositions,
          errors: m.errors,
          'Jaccard vs b1': num(m.meanJaccard),
          'b2-vs-b1 yardstick': num(baseline.yardstick),
          'thicken agree': pct(m.thickenAgreement),
          thickens: m.thickens,
          'skipped thickens': m.skippedThickens,
          'fallback warnings': m.fallbackWarnings,
          'intent agree': pct(m.intentAgreement),
          'p50 ms': ms(m.p50LatencyMs),
          'max ms': ms(m.maxLatencyMs),
          '$/comp Pro': usd(m.usdPerComposition.pro),
          '$/comp Flash intro': usd(m.usdPerComposition.flashIntro),
          '$/comp Flash 2027': usd(m.usdPerComposition.flash2027),
        },
      ]),
    ),
  );
  console.log(`  Agreement is vs baseline run 1 over the ${baseline.run1.compared} compositions it produced; an arm's failed composition counts as a disagreement. The yardstick covers the ${baseline.bothValid} valid in both baseline runs. Baseline p50/max (both runs pooled): ${ms(baseline.p50LatencyMs)}/${ms(baseline.maxLatencyMs)} ms.`);
}

function printBars(arm: ArmName, verdict: Verdict, bars: ReturnType<typeof composerBars>['bars'], reason?: string): void {
  const n = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
  console.log(`\nBars — ${arm} vs baseline:`);
  for (const b of bars) console.log(`  ${b.pass ? 'PASS' : 'FAIL'}  ${b.name}: measured ${n(b.measured)} ${b.comparator} threshold ${n(b.threshold)}`);
  console.log(`  automated: ${arm} ${verdict}${reason ? ` (${reason})` : ''}`);
  if (verdict === 'INCONCLUSIVE') console.log('  The comparison cannot decide: no further arm runs, and M8 must not proceed on this result.');
}

function score(ctx: Ctx, arm: ArmName, outcomes: Record<ArmName, Outcome[]>, run2: readonly Outcome[], armRows: [string, ComposerRunMetrics][]): Verdict {
  const baseline = summarizeBaseline(outcomes.baseline, run2);
  const failed = [...outcomes.baseline.map((o) => ['1', o] as const), ...run2.map((o) => ['2', o] as const)].filter(([, o]) => o.record === null);
  for (const [run, o] of failed) console.log(`  baseline run ${run} failed ${o.compositionId}, left out of the yardstick: ${o.error}`);
  for (const o of outcomes[arm].filter((x) => x.record === null)) console.log(`  ${arm} failed ${o.compositionId}, scored as a disagreement: ${o.error}`);
  const metrics = summarizeRun(outcomes[arm], outcomes.baseline, run2);
  armRows.push([arm, metrics]);
  printSummary([['baseline run 1', baseline.run1], ['baseline run 2', baseline.run2], ...armRows], baseline);
  const { bars, verdict, reason } = composerBars(metrics, baseline);
  printBars(arm, verdict, bars, reason);
  appendResult(ctx.file, { kind: 'verdict', runId: ctx.runId, arm, verdict, reason, bars, metrics, baseline });
  return verdict;
}

function printFinal(candidate: ArmName | null, lastVerdict: Verdict | undefined, human: HumanRead | undefined): string {
  const final = candidate === null ? (lastVerdict ?? 'FAIL') : finalVerdict('PASS', human);
  console.log(`\nFINAL VERDICT: trackComposer ${candidate === null ? '— no arm passed the automated bars —' : `→ ${candidate}`} ${final}`);
  if (final === 'PENDING HUMAN READ') {
    console.log('  Read composer-side-by-side(-smoke).md, unblind it with composer-side-by-side-key(-smoke).json, then re-run with --human-read=pass|fail (plus --smoke for a smoke run).');
  }
  return final;
}

function writeSideBySide(ctx: Ctx, comps: readonly Composition[], outcomes: Record<ArmName, Outcome[]>, candidate: ArmName, smoke: boolean): void {
  const recordOf = (arm: ArmName, id: string) => outcomes[arm].find((o) => o.compositionId === id)?.record ?? null;
  const items: SideBySideItem[] = comps.flatMap((c) => {
    const baseline = recordOf('baseline', c.id);
    const cand = recordOf(candidate, c.id);
    if (!baseline || !cand) return [];
    const s = c.scenario;
    const learner = `Learner: "${s.goal}"; prior knowledge: ${s.priorKnowledge ?? '(none)'}; target ${s.targetMastery}; ${s.timeframeWeeks} weeks × ${s.hoursPerWeek} h.`;
    return [{ compositionId: c.id, heading: `${c.topic} · ${s.label}`, learner, baseline, candidate: cand }];
  });
  const { markdown, key } = sideBySide(items.slice(0, SIDE_BY_SIDE), candidate, Math.random);
  const suffix = smoke ? '-smoke' : '';
  writeFileSync(join(AUDIT_DIR, `composer-side-by-side${suffix}.md`), markdown);
  writeFileSync(join(AUDIT_DIR, `composer-side-by-side-key${suffix}.json`), `${JSON.stringify({ runId: ctx.runId, key }, null, 2)}\n`);
  console.log(`\nWrote composer-side-by-side${suffix}.md (${Object.keys(key).length} compositions) and composer-side-by-side-key${suffix}.json under docs/audits/pro-to-flash/.`);
}

async function compare(ctx: Ctx, comps: readonly Composition[], smoke: boolean): Promise<void> {
  console.log(`${smoke ? 'SMOKE' : 'FULL'} run ${ctx.runId}: ${comps.length} compositions, price point ${pricePointOn(new Date())}`);
  console.log(formatLedger());
  appendResult(ctx.file, { kind: 'run-start', runId: ctx.runId, compositionIds: comps.map((c) => c.id) });
  const outcomes: Record<ArmName, Outcome[]> = { baseline: [], 'flash-low': [], 'flash-default': [], 'pro-low': [] };
  let run2: Outcome[] = [];
  const armRows: [string, ComposerRunMetrics][] = [];
  const pilot = comps.slice(0, smoke ? 1 : PILOT_INPUTS);

  console.log(smoke ? '\nSmoke: baseline once and flash-low' : `\nPilot: ${PILOT_INPUTS} compositions, baseline ×2 and flash-low`);
  outcomes.baseline = await composeAll(ctx, 'baseline', 1, pilot, []);
  if (!smoke) run2 = await composeAll(ctx, 'baseline', 2, pilot, outcomes.baseline);
  outcomes['flash-low'] = await composeAll(ctx, 'flash-low', 1, pilot, []);

  if (smoke) {
    console.log('\nSMOKE: n=1 and one baseline run — the bars below are meaningless (no yardstick), printed only to exercise the output.');
    score(ctx, 'flash-low', outcomes, run2, armRows);
    // flash-low is the candidate regardless, so the human-read gate can be exercised.
    writeSideBySide(ctx, comps, outcomes, 'flash-low', smoke);
    appendResult(ctx.file, { kind: 'run-end', runId: ctx.runId, candidate: 'flash-low' });
    printFinal('flash-low', undefined, undefined);
    return;
  }

  // The pilot compositions are the first of the full set, so the projection covers only the rest.
  const projection = projectRun({
    driver: 'composer',
    costPerInputByArmRun: [perInputUsd(outcomes.baseline), perInputUsd(run2), perInputUsd(outcomes['flash-low'])],
    target: TARGET_INPUTS - PILOT_INPUTS,
    minimum: MINIMUM_INPUTS - PILOT_INPUTS,
  });
  const total = PILOT_INPUTS + projection.inputs;
  console.log(`\nProjection: ${projection.kind}, ${total} of ${TARGET_INPUTS} compositions fit (minimum ${MINIMUM_INPUTS}). ${formatLedger()}`);
  if (projection.kind === 'below-minimum') {
    console.log('STOP: the composer allotment cannot reach the minimum composition count; the full comparison was not run.');
    return;
  }
  const rest = comps.slice(PILOT_INPUTS, total);
  console.log('\nBaseline ×2 over the remaining compositions');
  outcomes.baseline.push(...(await composeAll(ctx, 'baseline', 1, rest, outcomes.baseline)));
  run2.push(...(await composeAll(ctx, 'baseline', 2, rest, run2)));

  const results = await walkLadder(LADDER, async (arm) => {
    console.log(`\nArm ${arm}`);
    if (arm !== 'flash-low') {
      outcomes[arm] = await composeAll(ctx, arm, 1, pilot, []);
      const fits = projectRun({ driver: 'composer', costPerInputByArmRun: [perInputUsd(outcomes[arm])], target: rest.length, minimum: rest.length });
      if (fits.kind !== 'fits') {
        throw new BudgetRefusedError(`refused: ${arm} needs ${rest.length} more compositions to match the baseline and the allotment covers ${fits.inputs}`);
      }
    }
    outcomes[arm].push(...(await composeAll(ctx, arm, 1, rest, outcomes[arm])));
    return { verdict: score(ctx, arm, outcomes, run2, armRows), result: null };
  });

  const passed = results.find((o) => o.verdict === 'PASS');
  const candidate = passed ? passed.arm : null;
  if (candidate !== null) writeSideBySide(ctx, comps.slice(0, total), outcomes, candidate, smoke);
  appendResult(ctx.file, { kind: 'run-end', runId: ctx.runId, candidate });
  printFinal(candidate, results.at(-1)?.verdict, undefined);
}

// Re-prints the last completed run from its JSONL and records the user's read.
function recordHumanRead(file: string, human: HumanRead): void {
  const path = join(AUDIT_DIR, `${file}.jsonl`);
  if (!existsSync(path)) throw new Error(`no ${file}.jsonl: run the comparison first`);
  const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l): unknown => JSON.parse(l));
  const run = lastCompletedRun(rows);
  if (run === null || run.verdicts.length === 0) throw new Error(`no completed run with verdicts in ${file}.jsonl`);
  console.log(`Run ${run.runId}, human read: ${human}`);
  const last = run.verdicts[run.verdicts.length - 1];
  printSummary([['baseline run 1', last.baseline.run1], ['baseline run 2', last.baseline.run2], ...run.verdicts.map((v): [string, ComposerRunMetrics] => [v.arm, v.metrics])], last.baseline);
  for (const v of run.verdicts) printBars(v.arm, v.verdict, v.bars, v.reason);
  if (run.candidate === null) console.log('\nNo arm passed the automated bars, so the human read has nothing to decide.');
  const final = printFinal(run.candidate, last.verdict, human);
  appendResult(file, { kind: 'human-read', runId: run.runId, arm: run.candidate, humanRead: human, final });
}

// The pinned Paths are production ids; a dev DB falls back to its first spine_ready Path.
async function smokeComposition(): Promise<Composition> {
  const present = await prisma.path.findMany({ where: { id: { in: PATHS.map((p) => p.id) } }, select: { id: true } });
  const pinned = COMPOSITIONS.find((c) => present.some((p) => p.id === c.pathId));
  if (pinned) return pinned;
  const fallback = await prisma.path.findFirst({ where: { status: PathStatus.spine_ready }, orderBy: { id: 'asc' }, select: { id: true, topic: true } });
  if (!fallback) throw new Error('no spine_ready Path on this DB');
  return { ...COMPOSITIONS[0], id: `${fallback.topic}:${COMPOSITIONS[0].scenario.label.replaceAll(' ', '-')}`, pathId: fallback.id, topic: fallback.topic };
}

// One read per Path, reused by every arm, so a concurrent production build that
// attaches resources mid-run can't give two arms different inputs.
async function loadMaps(comps: readonly Composition[]): Promise<Map<string, Loaded>> {
  const maps = new Map<string, Loaded>();
  for (const pathId of new Set(comps.map((c) => c.pathId))) {
    const path = await prisma.path.findUnique({ where: { id: pathId }, select: { topic: true, status: true } });
    if (!path) throw new Error(`no Path ${pathId} on this DB`);
    if (path.status !== PathStatus.spine_ready) throw new Error(`Path ${pathId} (${path.topic}) is ${path.status}, not spine_ready`);
    const loaded = await loadComposerMap(pathId);
    const candidates = loaded.concepts.reduce((sum, c) => sum + c.candidates.length, 0);
    console.log(`Path ${path.topic} (${pathId}): ${loaded.concepts.length} concepts, ${loaded.edges.length} edges, ${candidates} candidates`);
    maps.set(pathId, loaded);
  }
  return maps;
}

async function snapshot() {
  const [track, lesson] = await Promise.all([prisma.track.count(), prisma.lesson.count()]);
  return { track, lesson };
}

async function main(): Promise<void> {
  const smoke = process.argv.includes('--smoke');
  const file = smoke ? 'composer-smoke' : 'composer';
  const human = parseHumanRead(process.argv);
  if (human !== undefined) return recordHumanRead(file, human);

  const comps = smoke ? [await smokeComposition()] : COMPOSITIONS;
  if (smoke) console.log(`Smoke composition: ${comps[0].id} on Path ${comps[0].pathId}${PATHS.some((p) => p.id === comps[0].pathId) ? '' : ', a fallback — no pinned Path is on this DB'}`);
  const before = await snapshot();
  try {
    const maps = await loadMaps(comps);
    await compare({ runId: randomUUID(), file, maps }, comps, smoke);
  } catch (err) {
    if (!(err instanceof BudgetRefusedError)) throw err;
    console.error(`\nSTOP: ${err.message}`);
    process.exitCode = 2;
  } finally {
    const after = await snapshot();
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(`\nTrack and Lesson row counts ${unchanged ? 'unchanged' : 'CHANGED'}: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
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
