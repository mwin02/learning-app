// Shared entry point for the Pro-to-Flash comparison drivers (`pro-to-flash.md`).
// Not run directly: a driver imports it, then calls `runArm` once per input per
// arm. The ledger enforces the plan's $15 cap across every run of every driver,
// so it lives on disk and survives process restarts.
//
// Output goes to docs/audits/pro-to-flash/ (git-ignored; created on first write).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentName } from '../src/lib/ai/models';
import { runWithCompareScope, type CompareCallRecord } from '../src/lib/ai/compare-scope';
import {
  armOverrides,
  checkBudget,
  EMPTY_LEDGER,
  ledgerSchema,
  ledgerTotal,
  pricePointOn,
  projectInputs,
  remainingUsd,
  totalCost,
  type ArmName,
  type CostByPricePoint,
  type Driver,
  type Ledger,
  type Projection,
} from '../src/lib/ai/model-compare';

export const AUDIT_DIR = resolve(process.cwd(), 'docs/audits/pro-to-flash');
export const DEFAULT_LEDGER_PATH = join(AUDIT_DIR, 'ledger.json');

export class BudgetRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BudgetRefusedError';
  }
}

export function readLedger(path = DEFAULT_LEDGER_PATH): Ledger {
  if (!existsSync(path)) return EMPTY_LEDGER;
  return ledgerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

// Synchronous read-modify-write, so concurrent inputs in one process can't
// interleave; written via rename so a crash never leaves a half-written ledger.
function charge(path: string, driver: Driver, usd: number): Ledger {
  const ledger = readLedger(path);
  const next: Ledger = { spentUsd: { ...ledger.spentUsd, [driver]: ledger.spentUsd[driver] + usd } };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...next, totalUsd: ledgerTotal(next), updatedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(tmp, path);
  return next;
}

// Projected cost admitted by `runArm` but not yet charged, per ledger file.
const pending = new Map<string, number>();

export type ArmRun<T> = {
  value: T;
  records: CompareCallRecord[];
  cost: CostByPricePoint;
  chargedUsd: number;
};

// Refuses before `fn` starts if `projectedUsd` would cross the driver's allotment
// or the cap. Charges the actual cost of every attempt the sink saw, at today's
// price point, even when `fn` throws.
export async function runArm<T>(args: {
  driver: Driver;
  agent: AgentName;
  arm: ArmName;
  projectedUsd: number;
  fn: () => Promise<T>;
  ledgerPath?: string;
}): Promise<ArmRun<T>> {
  const ledgerPath = args.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const held = pending.get(ledgerPath) ?? 0;
  const check = checkBudget(readLedger(ledgerPath), args.driver, args.projectedUsd, held);
  if (!check.ok) throw new BudgetRefusedError(check.reason);
  pending.set(ledgerPath, held + args.projectedUsd);

  const records: CompareCallRecord[] = [];
  const settle = (): { cost: CostByPricePoint; chargedUsd: number } => {
    pending.set(ledgerPath, (pending.get(ledgerPath) ?? 0) - args.projectedUsd);
    const cost = totalCost(records);
    const chargedUsd = cost[pricePointOn(new Date())];
    charge(ledgerPath, args.driver, chargedUsd);
    return { cost, chargedUsd };
  };

  let value: T;
  try {
    value = await runWithCompareScope(
      { overrides: armOverrides(args.arm, args.agent), sink: (record) => records.push(record) },
      args.fn,
    );
  } catch (err) {
    settle();
    throw err;
  }
  return { value, records, ...settle() };
}

// How many inputs the driver's remaining budget covers, from pilot costs.
export function projectRun(args: {
  driver: Driver;
  costPerInputByArmRun: readonly number[];
  target: number;
  minimum: number;
  ledgerPath?: string;
}): Projection {
  return projectInputs({
    remainingUsd: remainingUsd(readLedger(args.ledgerPath ?? DEFAULT_LEDGER_PATH), args.driver),
    costPerInputByArmRun: args.costPerInputByArmRun,
    target: args.target,
    minimum: args.minimum,
  });
}

export function appendResult(name: string, row: Record<string, unknown>, dir = AUDIT_DIR): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

export function formatLedger(path = DEFAULT_LEDGER_PATH): string {
  const ledger = readLedger(path);
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const drivers = Object.entries(ledger.spentUsd).map(([driver, spent]) => `${driver} ${usd(spent)}`);
  return `ledger: total ${usd(ledgerTotal(ledger))} (${drivers.join(', ')})`;
}
