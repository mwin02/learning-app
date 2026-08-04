// Validation pipeline driver.
//
// Runs validators in cost-ascending order. Each validator only sees rows that
// survived the previous one — so expensive LLM checks only spend tokens on
// what's already passed the cheap network check.
//
// Rejected rows are returned with the validator id + reason for logging /
// future analytics. Nothing is persisted at this layer.
//
// Quarantine (the non-destructive gate) is a THIRD outcome, and it is deliberately
// STICKY rather than an early exit: a quarantined row keeps flowing through the
// remaining validators, so an expensive check that finds it's a link farm can still
// drop it outright instead of queuing junk for a human. Nothing a later validator
// says can clear the flag either — `rules-agent` approving the content is no
// evidence the URL resolves. Only rows that reach the end still flagged come back
// as `quarantined`.

import type { ValidatableResource, Validator, ValidatorVerdict } from './types';

export type Rejection<T> = { row: T; validator: string; reason: string };

export type PipelineResult<T extends ValidatableResource> = {
  valid: T[];
  // Persist-but-don't-attach: failed a heuristic check that isn't trusted enough
  // to delete on. The validator + reason are for the CALLER — logs and diagnostics
  // at the end of a sourcing run. They are not persisted: a quarantined row reaches
  // the review queue as an ordinary `pending_review` row, and the reviewer's
  // evidence is the URL itself. Worth revisiting if a second validator ever
  // quarantines, since "why is this here" stops being answerable from context.
  quarantined: Rejection<T>[];
  rejected: Rejection<T>[];
};

const COST_ORDER = { cheap: 0, medium: 1, expensive: 2 } as const;

export async function runValidationPipeline<T extends ValidatableResource>(
  rows: T[],
  validators: Validator<T>[],
): Promise<PipelineResult<T>> {
  const ordered = [...validators].sort((a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost]);
  const rejected: Rejection<T>[] = [];
  // url -> the first quarantine verdict seen for it. Keyed by url (not row) so the
  // flag survives every subsequent stage; first-writer-wins keeps the reason that
  // originally caused it.
  const quarantinedByUrl = new Map<string, Rejection<T>>();
  let current = rows;

  for (const v of ordered) {
    if (current.length === 0) break;
    const verdicts = await v.validate(current);
    const verdictByUrl = new Map<string, ValidatorVerdict>(verdicts.map((vd) => [vd.url, vd]));
    const survivors: T[] = [];
    let quarantinedHere = 0;
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
      } else if (verdict.quarantine) {
        // Keep flowing: a later, more discerning validator may still reject it
        // outright, and that outcome is strictly better than queuing it.
        if (!quarantinedByUrl.has(row.url)) {
          quarantinedByUrl.set(row.url, { row, validator: v.id, reason: verdict.reason });
          quarantinedHere += 1;
        }
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
      quarantined: quarantinedHere,
      rejected: current.length - survivors.length,
    });
    current = survivors;
  }

  // A row hard-rejected by a later stage leaves `current`, so it is dropped even if
  // an earlier stage had quarantined it — intersecting here is what makes that true.
  const quarantined = current.flatMap((row) => {
    const q = quarantinedByUrl.get(row.url);
    return q ? [q] : [];
  });
  const quarantinedUrls = new Set(quarantined.map((q) => q.row.url));
  return { valid: current.filter((r) => !quarantinedUrls.has(r.url)), quarantined, rejected };
}
