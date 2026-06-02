// Validation pipeline driver.
//
// Runs validators in cost-ascending order. Each validator only sees rows that
// survived the previous one — so expensive LLM checks only spend tokens on
// what's already passed the cheap network check.
//
// Rejected rows are returned with the validator id + reason for logging /
// future analytics. Nothing is persisted at this layer.

import type { ValidatableResource, Validator, ValidatorVerdict } from './types';

export type Rejection<T> = { row: T; validator: string; reason: string };

export type PipelineResult<T extends ValidatableResource> = {
  valid: T[];
  rejected: Rejection<T>[];
};

const COST_ORDER = { cheap: 0, medium: 1, expensive: 2 } as const;

export async function runValidationPipeline<T extends ValidatableResource>(
  rows: T[],
  validators: Validator<T>[],
): Promise<PipelineResult<T>> {
  const ordered = [...validators].sort((a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost]);
  const rejected: Rejection<T>[] = [];
  let current = rows;

  for (const v of ordered) {
    if (current.length === 0) break;
    const verdicts = await v.validate(current);
    const verdictByUrl = new Map<string, ValidatorVerdict>(verdicts.map((vd) => [vd.url, vd]));
    const survivors: T[] = [];
    for (const row of current) {
      const verdict = verdictByUrl.get(row.url);
      // Missing verdict = the validator didn't return one for this URL. Treat
      // as rejection rather than silently passing — a buggy validator
      // shouldn't accidentally upgrade rows.
      if (!verdict) {
        rejected.push({ row, validator: v.id, reason: 'no verdict returned' });
        continue;
      }
      if (verdict.valid) {
        survivors.push(row);
      } else {
        rejected.push({ row, validator: v.id, reason: verdict.reason });
      }
    }
    console.log('[validation] stage', {
      validator: v.id,
      cost: v.cost,
      input: current.length,
      survivors: survivors.length,
      rejected: current.length - survivors.length,
    });
    current = survivors;
  }

  return { valid: current, rejected };
}
