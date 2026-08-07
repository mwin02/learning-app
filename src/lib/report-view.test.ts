// Unit tests for the report dialog's presentational derivations (R3).

import { describe, it, expect } from 'vitest';
import {
  acknowledgementFor,
  pendingLabelFor,
  reportCategoryOptions,
  reportErrorMessage,
} from './report-view';

describe('reportCategoryOptions', () => {
  it('offers every category for an external resource', () => {
    const values = reportCategoryOptions({ generated: false }).map((o) => o.value);
    expect(values).toContain('dead_link');
    expect(values).toHaveLength(8);
  });

  it('hides dead_link for a generated resource (no external URL to be dead)', () => {
    const values = reportCategoryOptions({ generated: true }).map((o) => o.value);
    expect(values).not.toContain('dead_link');
    expect(values).toHaveLength(7);
  });

  it('gives every option non-empty plain-language wording', () => {
    for (const opt of reportCategoryOptions({ generated: false })) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.label).not.toContain('_');
    }
  });
});

describe('acknowledgementFor', () => {
  it('says the resource was removed only when the probe acted', () => {
    expect(acknowledgementFor('confirmed_dead')).toMatch(/removed from future courses/);
  });

  it('reports an earlier removal plainly', () => {
    expect(acknowledgementFor('already_deprecated')).toMatch(/already removed/i);
  });

  it('falls back to the review acknowledgement for every non-acting verdict', () => {
    const generic = "Thanks — we'll review this.";
    expect(acknowledgementFor('inconclusive')).toBe(generic);
    expect(acknowledgementFor('appears_live')).toBe(generic);
    expect(acknowledgementFor('skipped')).toBe(generic);
    expect(acknowledgementFor(undefined)).toBe(generic);
  });
});

describe('pendingLabelFor', () => {
  it('is honest about the synchronous dead-link probe', () => {
    expect(pendingLabelFor('dead_link')).toBe('Checking the link…');
    expect(pendingLabelFor('wrong_topic')).toBe('Sending…');
  });
});

describe('reportErrorMessage', () => {
  it('maps each route code to its own copy', () => {
    const codes = ['UNAUTHENTICATED', 'RATE_LIMITED', 'REPORT_COOLDOWN', 'INVALID_INPUT', 'NOT_FOUND'];
    // Not `codes.map(reportErrorMessage)` — map would pass the array index as
    // retryAfterMs and quietly change what REPORT_COOLDOWN renders.
    const messages = codes.map((code) => reportErrorMessage(code));
    expect(new Set(messages).size).toBe(codes.length);
  });

  it('falls back for an unknown or missing code', () => {
    expect(reportErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
    expect(reportErrorMessage('WAT')).toBe('Something went wrong. Please try again.');
  });

  // F1's per-row cooldown is a second 429 with a different scope. Sharing
  // RATE_LIMITED's line told a learner one report into a limit of ten that they had
  // filed "too many reports recently" — false, and actionable by nobody.
  describe('REPORT_COOLDOWN', () => {
    const message = (retryAfterMs?: unknown) => reportErrorMessage('REPORT_COOLDOWN', retryAfterMs);

    it('is distinct from the burst cap copy', () => {
      expect(message(60_000)).not.toBe(reportErrorMessage('RATE_LIMITED'));
      expect(message(60_000)).not.toMatch(/too many/i);
    });

    it('names the scope and the remaining wait', () => {
      expect(message(7 * 60_000)).toBe(
        'You already reported this resource — you can report it again in 7 minutes.'
      );
    });

    it('rounds a partial minute up rather than saying zero', () => {
      expect(message(90_000)).toMatch(/in 2 minutes/);
      expect(message(30_000)).toMatch(/in a minute/);
    });

    it('degrades to a vaguer sentence when the wait is missing or junk', () => {
      const vague = 'You already reported this resource — you can report it again shortly.';
      expect(message(undefined)).toBe(vague);
      expect(message('soon')).toBe(vague);
      expect(message(Number.NaN)).toBe(vague);
      expect(message(-1)).toBe(vague);
    });
  });
});
