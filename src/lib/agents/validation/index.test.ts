// The pipeline's three-way split. The subtle properties are that quarantine is
// STICKY (survives later stages) but not FINAL (a later hard reject still wins),
// because those two together are what make it safe to quarantine generously.

import { describe, it, expect } from 'vitest';
import { runValidationPipeline } from '@/lib/agents/validation';
import type { Validator, ValidatableResource, ValidatorVerdict } from '@/lib/agents/validation/types';

const row = (url: string): ValidatableResource => ({ url, title: 't', summary: 's', type: 'article' });

// Builds a validator from a url -> verdict-shape map. `cost` drives ordering.
function stub(
  id: string,
  cost: 'cheap' | 'medium' | 'expensive',
  decide: (url: string) => 'ok' | 'quarantine' | 'reject' | 'silent',
): Validator {
  return {
    id,
    cost,
    async validate(rows) {
      const out: ValidatorVerdict[] = [];
      for (const r of rows) {
        const d = decide(r.url);
        if (d === 'silent') continue;
        if (d === 'ok') out.push({ url: r.url, valid: true });
        else if (d === 'quarantine') out.push({ url: r.url, valid: false, reason: `${id} unsure`, quarantine: true });
        else out.push({ url: r.url, valid: false, reason: `${id} says no` });
      }
      return out;
    },
  };
}

const urls = (rs: { url: string }[]) => rs.map((r) => r.url).sort();

describe('runValidationPipeline', () => {
  it('splits rows three ways', async () => {
    const v = stub('a', 'cheap', (u) =>
      u === '1' ? 'ok' : u === '2' ? 'quarantine' : 'reject',
    );
    const res = await runValidationPipeline([row('1'), row('2'), row('3')], [v]);
    expect(urls(res.valid)).toEqual(['1']);
    expect(urls(res.quarantined.map((q) => q.row))).toEqual(['2']);
    expect(urls(res.rejected.map((r) => r.row))).toEqual(['3']);
  });

  it('keeps a quarantined row flowing so later validators still see it', async () => {
    const seen: string[] = [];
    const cheap = stub('cheap', 'cheap', (u) => (u === '1' ? 'quarantine' : 'ok'));
    const later: Validator = {
      id: 'later',
      cost: 'expensive',
      async validate(rows) {
        seen.push(...rows.map((r) => r.url));
        return rows.map((r) => ({ url: r.url, valid: true as const }));
      },
    };
    const res = await runValidationPipeline([row('1'), row('2')], [cheap, later]);
    expect(seen.sort()).toEqual(['1', '2']);
    expect(urls(res.quarantined.map((q) => q.row))).toEqual(['1']);
  });

  it('lets a later hard reject override an earlier quarantine — junk is dropped, not queued', async () => {
    const cheap = stub('cheap', 'cheap', () => 'quarantine');
    const strict = stub('strict', 'expensive', () => 'reject');
    const res = await runValidationPipeline([row('1')], [cheap, strict]);
    expect(res.valid).toEqual([]);
    expect(res.quarantined).toEqual([]);
    expect(res.rejected).toHaveLength(1);
  });

  it('does NOT let a later validator clear the flag — passing content rules is no proof the url resolves', async () => {
    const cheap = stub('cheap', 'cheap', () => 'quarantine');
    const lenient = stub('lenient', 'expensive', () => 'ok');
    const res = await runValidationPipeline([row('1')], [cheap, lenient]);
    expect(res.valid).toEqual([]);
    expect(res.quarantined).toHaveLength(1);
    expect(res.quarantined[0].reason).toBe('cheap unsure');
  });

  it('keeps the first quarantine reason when two stages both flag a row', async () => {
    const first = stub('first', 'cheap', () => 'quarantine');
    const second = stub('second', 'expensive', () => 'quarantine');
    const res = await runValidationPipeline([row('1')], [first, second]);
    expect(res.quarantined).toHaveLength(1);
    expect(res.quarantined[0].validator).toBe('first');
  });

  it('still treats a missing verdict as a rejection, never a quarantine', async () => {
    const res = await runValidationPipeline([row('1')], [stub('a', 'cheap', () => 'silent')]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toBe('no verdict returned');
    expect(res.quarantined).toEqual([]);
  });

  it('runs validators cheapest-first', async () => {
    const order: string[] = [];
    const mk = (id: string, cost: 'cheap' | 'medium' | 'expensive'): Validator => ({
      id,
      cost,
      async validate(rows) {
        order.push(id);
        return rows.map((r) => ({ url: r.url, valid: true as const }));
      },
    });
    await runValidationPipeline([row('1')], [mk('x', 'expensive'), mk('y', 'cheap'), mk('z', 'medium')]);
    expect(order).toEqual(['y', 'z', 'x']);
  });
});
