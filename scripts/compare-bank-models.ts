// M5 of `pro-to-flash.md`: does `conceptBankAuthor` hold its answer-key quality on
// Flash? Authors a bank per concept per arm with `authorConceptBank`, at production's
// concurrency, from the same fields the backfill loads; then grades every bank blind
// with one `compareGrader` call each. Nothing is persisted; the script checks that the
// ConceptQuestion row count and the touched concepts' bankAttemptedAt are unchanged.
//
// Production run (pilot, projection, baseline, then the ladder; writes the blind sample):
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/compare-bank-models.ts
// Smoke run (1 concept, baseline + flash-low, no pilot/projection/ladder), against
// whatever DATABASE_URL points at — the local dev DB when run directly:
//   npx tsx --env-file=.env.local scripts/compare-bank-models.ts --smoke
// Record the user's blind read of the last completed run (no DB, no model call):
//   npx tsx --env-file=.env.local scripts/compare-bank-models.ts --human-read=pass|fail [--smoke]
//
// Every model call (author and grader) is charged to the `banks` allotment in the
// ledger (docs/audits/pro-to-flash/ledger.json). Results append to
// docs/audits/pro-to-flash/banks.jsonl (banks-smoke.jsonl); the blind sample and its
// key go to blind-sample.md and blind-key.json (…-smoke) beside them.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NoObjectGeneratedError, Output, generateText } from 'ai';
import { prisma } from '../src/lib/db';
import { getModel } from '../src/lib/ai/models';
import { recordUsage } from '../src/lib/log';
import { CONCEPT_BANK_GEN_CONCURRENCY } from '../src/lib/config';
import { authorConceptBank, type AuthoredQuestion, type ConceptBankResource } from '../src/lib/agents/content/author-concept-bank';
import { LADDER, pricePointOn, type ArmName } from '../src/lib/ai/model-compare';
import { walkLadder, type Verdict } from '../src/lib/ai/discovery-compare';
import {
  bankBars,
  blindSample,
  buildGraderPrompt,
  count429s,
  finalVerdict,
  GRADER_SYSTEM_PROMPT,
  graderSchema,
  lastCompletedRun,
  parseGrades,
  parseHumanRead,
  shuffle,
  summarizeBanks,
  type BankInputResult,
  type BankRunMetrics,
  type HumanRead,
  type QuestionGrade,
} from '../src/lib/ai/bank-compare';
import { appendResult, AUDIT_DIR, BudgetRefusedError, formatLedger, projectRun, runArm } from './model-compare-harness';

// Fixed before any run (the plan's rule). Non-on-ramp, ≥3 attached resources in
// production, 3 per topic, spine and frontier mixed. operating-systems is the Path of
// request cmuro8iil000301s6fy7bj5fq (io-systems and mass-storage-management are its
// thicken concepts). Interleaved by topic so the pilot and any shrunk prefix stay spread.
const CONCEPTS: readonly { id: string; slug: string }[] = [
  { id: 'cmt44bjwg0008fcm5h9mxns2s', slug: 'operating-systems::io-systems' },
  { id: 'cmsa4t93v00diatm5lhcamr4f', slug: 'calculus::fundamental-theorem-of-calculus' },
  { id: 'cmsa552xx00i3atm5xtszizgr', slug: 'linear-algebra::eigenvalues-and-eigenvectors' },
  { id: 'cmsa2kt9n004katm5miftumy5', slug: 'python-data-ml::data-manipulation-pandas' },
  { id: 'cmsa4gkgm009uatm55rrdl9gd', slug: 'javascript-react::side-effects-with-useeffect' },
  { id: 'cmt44bjwg0009fcm54ey7i8u7', slug: 'operating-systems::mass-storage-management' },
  { id: 'cmsa4t93v00dfatm5u1788pdh', slug: 'calculus::lhopitals-rule' },
  { id: 'cmsa552xx00i1atm5njndld6h', slug: 'linear-algebra::determinants' },
  { id: 'cmsa2kt9p004tatm5p29o5nfr', slug: 'python-data-ml::model-evaluation-and-selection' },
  { id: 'cmsa4gkgm009oatm5vkdz241w', slug: 'javascript-react::managing-state-with-usestate' },
  { id: 'cmt44bjwf0004fcm5jrm66kz6', slug: 'operating-systems::deadlocks' },
  { id: 'cmsa4u6vg00fzatm5jpogn9qn', slug: 'calculus::taylor-and-maclaurin-series' },
  { id: 'cmsa55v2y00kvatm58jx4sa0b', slug: 'linear-algebra::singular-value-decomposition' },
  { id: 'cmsa2lg1c006natm5ya5sbcp8', slug: 'python-data-ml::dimensionality-reduction' },
  { id: 'cmsa4hcil00bnatm5vjdqheps', slug: 'javascript-react::performance-optimization-hooks' },
];

const TARGET_INPUTS = 15;
const MINIMUM_INPUTS = 12;
const PILOT_INPUTS = 2;
const SAMPLE_PER_ARM = 30;
// Admission estimates before an arm's pilot has measured a call: above a Pro author
// call (~1k in, a few k out with thinking) and a grader call that may run twice.
const UNPILOTED_AUTHOR_USD = 0.15;
const UNPILOTED_GRADE_USD = 0.25;
const PROJECTION_HEADROOM = 1.5;

type Concept = { id: string; slug: string; title: string; topic: string; resources: ConceptBankResource[] };
type Bank = BankInputResult & { arm: ArmName; concept: Concept; questions: AuthoredQuestion[]; authorUsd: number; gradeUsd: number };
type Ctx = { runId: string; file: string; gradeCosts: number[] };

async function loadConcept(id: string): Promise<Concept> {
  const c = await prisma.concept.findUnique({
    where: { id },
    select: {
      slug: true,
      title: true,
      isOnRamp: true,
      path: { select: { topic: true } },
      resources: { orderBy: { coverageScore: 'desc' }, select: { resource: { select: { title: true, type: true } } } },
    },
  });
  if (!c) throw new Error(`no Concept ${id} on this DB`);
  if (c.isOnRamp) throw new Error(`Concept ${id} is the on-ramp; the backfill never banks it`);
  return { id, slug: c.slug, title: c.title, topic: c.path.topic, resources: c.resources.map((r) => r.resource) };
}

// The pinned concepts are production ids; a dev DB falls back to its first eligible one.
async function smokeConceptId(): Promise<string> {
  const present = await prisma.concept.findMany({ where: { id: { in: CONCEPTS.map((c) => c.id) }, isOnRamp: false }, select: { id: true } });
  const pinned = CONCEPTS.find((c) => present.some((p) => p.id === c.id));
  if (pinned) return pinned.id;
  const fallback = await prisma.concept.findFirst({ where: { isOnRamp: false, resources: { some: {} } }, orderBy: { id: 'asc' }, select: { id: true } });
  if (!fallback) throw new Error('no non-on-ramp concept with attached resources on this DB');
  return fallback.id;
}

const admit = (costs: readonly number[], fallback: number) => {
  const max = Math.max(0, ...costs);
  return max > 0 ? max * PROJECTION_HEADROOM : fallback;
};

async function inChunks<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCEPT_BANK_GEN_CONCURRENCY) {
    const settled = await Promise.allSettled(items.slice(i, i + CONCEPT_BANK_GEN_CONCURRENCY).map(fn));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

// One arm over `concepts`, CONCEPT_BANK_GEN_CONCURRENCY at a time like the backfill.
async function author(ctx: Ctx, arm: ArmName, concepts: readonly Concept[], prior: readonly Bank[]): Promise<Bank[]> {
  const projectedUsd = admit(prior.map((b) => b.authorUsd), UNPILOTED_AUTHOR_USD);
  const banks: Bank[] = [];
  await inChunks(concepts, async (concept) => {
    let authored = 0;
    const bank: Bank = { arm, concept, questions: [], authored: 0, kept: 0, authorCalls: [], rateLimited: 0, authorUsd: 0, gradeUsd: 0 };
    try {
      const run = await runArm({
        driver: 'banks',
        agent: 'conceptBankAuthor',
        arm,
        projectedUsd,
        fn: () =>
          authorConceptBank({
            topic: concept.topic,
            conceptTitle: concept.title,
            conceptSlug: concept.slug,
            isOnRamp: false,
            resources: concept.resources,
            // `authored` (before the MCQ-format drop) is only reported through the trace.
            onTrace: (e) => {
              if (e.label === 'concept bank author done') authored = Number(e.detail?.kept ?? 0) + Number(e.detail?.dropped ?? 0);
            },
          }),
      });
      Object.assign(bank, { questions: run.value, authored, kept: run.value.length, authorUsd: run.chargedUsd });
      bank.authorCalls = run.records.filter((r) => r.agent === 'conceptBankAuthor');
    } catch (err) {
      if (err instanceof BudgetRefusedError) throw err;
      // runArm already charged the spent attempts; the bank scores as empty.
      bank.error = err instanceof Error ? err.message : String(err);
      bank.rateLimited = count429s(err);
    }
    // Nothing to grade: an empty grade list, not an ungraded bank.
    if (bank.questions.length === 0) bank.grades = [];
    banks.push(bank);
    const { authorCalls, rateLimited, error, questions } = bank;
    appendResult(ctx.file, { kind: 'bank', runId: ctx.runId, arm, conceptId: concept.id, slug: concept.slug, authored, kept: bank.kept, rateLimited, error, authorCalls, chargedUsd: bank.authorUsd, questions });
    console.log(`  ${arm} ${concept.topic}::${concept.slug}: ${bank.error ? `ERROR ${bank.error}` : `kept ${bank.kept}/${authored}`}, $${bank.authorUsd.toFixed(4)}`);
  });
  return banks;
}

async function gradeOne(ctx: Ctx, bank: Bank): Promise<void> {
  const prompt = buildGraderPrompt({ topic: bank.concept.topic, conceptTitle: bank.concept.title, resources: bank.concept.resources, questions: bank.questions });
  const failures: string[] = [];
  let grades: QuestionGrade[] | null = null;
  try {
    const run = await runArm({
      driver: 'banks',
      agent: 'compareGrader',
      arm: 'baseline',
      projectedUsd: admit(ctx.gradeCosts, UNPILOTED_GRADE_USD),
      fn: async () => {
        // A response that fails the schema (or skips a question) is retried once.
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const { model, temperature, maxOutputTokens, providerOptions } = getModel('compareGrader');
            const result = await generateText({ model, temperature, maxOutputTokens, providerOptions, output: Output.object({ schema: graderSchema }), system: GRADER_SYSTEM_PROMPT, prompt });
            recordUsage('compare.grade', result.usage);
            const parsed = parseGrades(result.experimental_output, bank.questions.length);
            if (parsed.ok) return parsed.grades;
            failures.push(parsed.reason);
          } catch (err) {
            if (!NoObjectGeneratedError.isInstance(err)) throw err;
            failures.push(err.message);
          }
        }
        return null;
      },
    });
    grades = run.value;
    bank.gradeUsd = run.chargedUsd;
    ctx.gradeCosts.push(run.chargedUsd);
  } catch (err) {
    if (err instanceof BudgetRefusedError) throw err;
    failures.push(err instanceof Error ? err.message : String(err));
  }
  bank.grades = grades;
  appendResult(ctx.file, { kind: 'grade', runId: ctx.runId, arm: bank.arm, conceptId: bank.concept.id, grades, failures, chargedUsd: bank.gradeUsd });
  if (grades === null) console.error(`  UNGRADED ${bank.concept.slug} (${bank.arm}): ${failures.join('; ')}`);
}

// Every ungraded bank in one shuffled queue, so the call order carries no arm.
async function grade(ctx: Ctx, banks: readonly Bank[]): Promise<void> {
  const pending = shuffle(banks.filter((b) => b.grades === undefined), Math.random);
  console.log(`  grading ${pending.length} banks blind, shuffled`);
  await inChunks(pending, (bank) => gradeOne(ctx, bank));
}

const perInputUsd = (banks: readonly Bank[]) => banks.reduce((sum, b) => sum + b.authorUsd + b.gradeUsd, 0) / Math.max(1, banks.length);

function printSummary(table: readonly [string, BankRunMetrics][]): void {
  const pct = (n: number | null) => (n === null ? '-' : `${(100 * n).toFixed(1)}%`);
  const usd = (n: number | null) => (n === null ? '-' : `$${n.toFixed(4)}`);
  const ms = (n: number | null) => (n === null ? '-' : String(Math.round(n)));
  console.table(
    Object.fromEntries(
      table.map(([name, m]) => [
        name,
        {
          banks: m.banks,
          errors: m.errors,
          ungraded: m.ungradedBanks,
          'key err': pct(m.keyErrorRate),
          'out of scope': pct(m.outOfScopeRate),
          'kept/authored': `${m.kept}/${m.authored}`,
          'p50 ms': ms(m.p50LatencyMs),
          'max ms': ms(m.maxLatencyMs),
          '429 (confirmed)': m.rateLimited,
          'failed attempts': m.failedAttempts,
          '$/bank Pro': usd(m.usdPerBank.pro),
          '$/bank Flash intro': usd(m.usdPerBank.flashIntro),
          '$/bank Flash 2027': usd(m.usdPerBank.flash2027),
        },
      ]),
    ),
  );
  console.log('  Rates are over graded questions; ungraded banks are excluded. "failed attempts" counts every failed author attempt the sink saw (a retried 429 shows only there).');
}

function printBars(arm: ArmName, verdict: Verdict, bars: ReturnType<typeof bankBars>['bars'], reason?: string): void {
  const n = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
  console.log(`\nBars — ${arm} vs baseline:`);
  for (const b of bars) console.log(`  ${b.pass ? 'PASS' : 'FAIL'}  ${b.name}: measured ${n(b.measured)} ${b.comparator} threshold ${n(b.threshold)}`);
  console.log(`  automated: ${arm} ${verdict}${reason ? ` (${reason})` : ''}`);
  if (verdict === 'INCONCLUSIVE') console.log('  The comparison cannot decide: no further arm runs, and M6 must not proceed on this result.');
}

// `armRows` accumulates across the ladder; the baseline row is recomputed because
// its later banks are graded alongside the first arm's.
function score(ctx: Ctx, arm: ArmName, banks: Record<ArmName, Bank[]>, armRows: [string, BankRunMetrics][]): Verdict {
  const baseline = summarizeBanks(banks.baseline);
  const metrics = summarizeBanks(banks[arm]);
  armRows.push([arm, metrics]);
  printSummary([['baseline', baseline], ...armRows]);
  const { bars, verdict, reason } = bankBars(metrics, baseline);
  printBars(arm, verdict, bars, reason);
  appendResult(ctx.file, { kind: 'verdict', runId: ctx.runId, arm, verdict, reason, bars, metrics, baseline });
  return verdict;
}

function printFinal(candidate: ArmName | null, lastVerdict: Verdict | undefined, human: HumanRead | undefined): string {
  const final = candidate === null ? (lastVerdict ?? 'FAIL') : finalVerdict('PASS', human);
  console.log(`\nFINAL VERDICT: conceptBankAuthor ${candidate === null ? '— no arm passed the automated bars —' : `→ ${candidate}`} ${final}`);
  if (final === 'PENDING HUMAN READ') {
    console.log('  Read blind-sample(-smoke).md, score it with blind-key(-smoke).json (0 wrong keys in the candidate\'s sample), then re-run with --human-read=pass|fail (plus --smoke for a smoke run).');
  }
  return final;
}

function writeSample(ctx: Ctx, banks: Record<ArmName, Bank[]>, candidate: ArmName, smoke: boolean): void {
  const questions = (arm: ArmName) =>
    banks[arm].flatMap((b) => b.questions.map((question) => ({ conceptId: b.concept.id, conceptTitle: b.concept.title, question })));
  const { markdown, key } = blindSample([{ arm: 'baseline', questions: questions('baseline') }, { arm: candidate, questions: questions(candidate) }], SAMPLE_PER_ARM, Math.random);
  const suffix = smoke ? '-smoke' : '';
  writeFileSync(join(AUDIT_DIR, `blind-sample${suffix}.md`), markdown);
  writeFileSync(join(AUDIT_DIR, `blind-key${suffix}.json`), `${JSON.stringify({ runId: ctx.runId, key }, null, 2)}\n`);
  console.log(`\nWrote blind-sample${suffix}.md (${Object.keys(key).length} questions) and blind-key${suffix}.json under docs/audits/pro-to-flash/.`);
}

async function compare(ctx: Ctx, concepts: readonly Concept[], smoke: boolean): Promise<void> {
  console.log(`${smoke ? 'SMOKE' : 'FULL'} run ${ctx.runId}: ${concepts.length} concepts, price point ${pricePointOn(new Date())}`);
  console.log(formatLedger());
  appendResult(ctx.file, { kind: 'run-start', runId: ctx.runId, conceptIds: concepts.map((c) => c.id) });
  const banks: Record<ArmName, Bank[]> = { baseline: [], 'flash-low': [], 'flash-default': [], 'pro-low': [] };
  const armRows: [string, BankRunMetrics][] = [];
  const pilot = concepts.slice(0, smoke ? 1 : PILOT_INPUTS);

  console.log(smoke ? '\nSmoke: baseline and flash-low' : `\nPilot: ${PILOT_INPUTS} concepts, baseline and flash-low`);
  banks.baseline = await author(ctx, 'baseline', pilot, []);
  banks['flash-low'] = await author(ctx, 'flash-low', pilot, []);
  await grade(ctx, [...banks.baseline, ...banks['flash-low']]);

  if (smoke) {
    console.log('\nSMOKE: n=1 — the bars below are meaningless, printed only to exercise the output.');
    const verdict = score(ctx, 'flash-low', banks, armRows);
    writeSample(ctx, banks, 'flash-low', smoke);
    appendResult(ctx.file, { kind: 'run-end', runId: ctx.runId, candidate: verdict === 'PASS' ? 'flash-low' : null });
    printFinal(verdict === 'PASS' ? 'flash-low' : null, verdict, undefined);
    return;
  }

  // The pilot concepts are the first of the full set, so the projection covers only the rest.
  const projection = projectRun({
    driver: 'banks',
    costPerInputByArmRun: [perInputUsd(banks.baseline), perInputUsd(banks['flash-low'])],
    target: TARGET_INPUTS - PILOT_INPUTS,
    minimum: MINIMUM_INPUTS - PILOT_INPUTS,
  });
  const total = PILOT_INPUTS + projection.inputs;
  console.log(`\nProjection: ${projection.kind}, ${total} of ${TARGET_INPUTS} concepts fit (minimum ${MINIMUM_INPUTS}). ${formatLedger()}`);
  if (projection.kind === 'below-minimum') {
    console.log('STOP: the banks allotment cannot reach the minimum concept count; the full comparison was not run.');
    return;
  }
  const rest = concepts.slice(PILOT_INPUTS, total);
  console.log('\nBaseline over the remaining concepts');
  banks.baseline.push(...(await author(ctx, 'baseline', rest, banks.baseline)));

  const outcomes = await walkLadder(LADDER, async (arm) => {
    console.log(`\nArm ${arm}`);
    if (arm !== 'flash-low') {
      banks[arm] = await author(ctx, arm, pilot, []);
      await grade(ctx, banks[arm]);
      const fits = projectRun({ driver: 'banks', costPerInputByArmRun: [perInputUsd(banks[arm])], target: rest.length, minimum: rest.length });
      if (fits.kind !== 'fits') {
        throw new BudgetRefusedError(`refused: ${arm} needs ${rest.length} more concepts to match the baseline and the allotment covers ${fits.inputs}`);
      }
    }
    banks[arm].push(...(await author(ctx, arm, rest, banks[arm])));
    // The baseline's remaining banks are still ungraded on the first arm, so they
    // are graded in one shuffled queue with that arm's.
    await grade(ctx, [...banks.baseline, ...banks[arm]]);
    const verdict = score(ctx, arm, banks, armRows);
    return { verdict, result: null };
  });

  const passed = outcomes.find((o) => o.verdict === 'PASS');
  const candidate = passed ? passed.arm : null;
  if (candidate !== null) writeSample(ctx, banks, candidate, smoke);
  appendResult(ctx.file, { kind: 'run-end', runId: ctx.runId, candidate });
  printFinal(candidate, outcomes.at(-1)?.verdict, undefined);
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
  printSummary([['baseline', last.baseline], ...run.verdicts.map((v): [string, BankRunMetrics] => [v.arm, v.metrics])]);
  for (const v of run.verdicts) printBars(v.arm, v.verdict, v.bars, v.reason);
  if (run.candidate === null) console.log('\nNo arm passed the automated bars, so the human read has nothing to decide.');
  const final = printFinal(run.candidate, last.verdict, human);
  appendResult(file, { kind: 'human-read', runId: run.runId, arm: run.candidate, humanRead: human, final });
}

async function snapshot(ids: readonly string[]) {
  const [conceptQuestion, concepts] = await Promise.all([
    prisma.conceptQuestion.count(),
    prisma.concept.findMany({ where: { id: { in: [...ids] } }, orderBy: { id: 'asc' }, select: { id: true, bankAttemptedAt: true } }),
  ]);
  return { conceptQuestion, bankAttemptedAt: Object.fromEntries(concepts.map((c) => [c.id, c.bankAttemptedAt?.toISOString() ?? null])) };
}

async function main(): Promise<void> {
  const smoke = process.argv.includes('--smoke');
  const file = smoke ? 'banks-smoke' : 'banks';
  const human = parseHumanRead(process.argv);
  if (human !== undefined) return recordHumanRead(file, human);

  const ids = smoke ? [await smokeConceptId()] : CONCEPTS.map((c) => c.id);
  const concepts = await Promise.all(ids.map(loadConcept));
  if (smoke) console.log(`Smoke concept: ${concepts[0].topic}::${concepts[0].slug} (${concepts[0].id})${CONCEPTS.some((c) => c.id === ids[0]) ? '' : ', a fallback — no pinned concept is on this DB'}`);
  const before = await snapshot(ids);
  try {
    await compare({ runId: randomUUID(), file, gradeCosts: [] }, concepts, smoke);
  } catch (err) {
    if (!(err instanceof BudgetRefusedError)) throw err;
    console.error(`\nSTOP: ${err.message}`);
    process.exitCode = 2;
  } finally {
    const after = await snapshot(ids);
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(`\nConceptQuestion count and bankAttemptedAt ${unchanged ? 'unchanged' : 'CHANGED'}: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
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
