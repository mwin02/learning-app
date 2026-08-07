// Unit tests for the report dialog's presentational derivations (R3).

import { describe, it, expect } from 'vitest';
import {
  NOTE_MAX_CHARS,
  acknowledgementFor,
  pendingLabelFor,
  reportCategoryOptions,
  reportErrorMessage,
  tabStops,
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

describe('tabStops', () => {
  type Stop = { id: string; radioGroup?: string; checked?: boolean };
  const read = (s: Stop) => ({ radioGroup: s.radioGroup, checked: s.checked });
  const ids = (items: Stop[]) => tabStops(items, read).map((s) => s.id);

  // The dialog's shape: a radio group, then the note field, then the buttons.
  const panel = (checkedId?: string): Stop[] => [
    ...['dead_link', 'wrong_topic', 'low_quality'].map((id) => ({
      id,
      radioGroup: 'report',
      checked: id === checkedId,
    })),
    { id: 'note' },
    { id: 'cancel' },
    { id: 'send' },
  ];

  it('collapses a radio group to its checked member', () => {
    expect(ids(panel('wrong_topic'))).toEqual(['wrong_topic', 'note', 'cancel', 'send']);
  });

  // The bug this exists to prevent: with DOM order, `first` stayed the top radio,
  // so wrapping forward focused an UNCHECKED one and Space refiled the report
  // under a category the learner never picked.
  it('makes the checked radio the first stop, not the first radio in the DOM', () => {
    expect(ids(panel('low_quality'))[0]).toBe('low_quality');
  });

  it('falls back to the first radio while nothing is checked', () => {
    expect(ids(panel())).toEqual(['dead_link', 'note', 'cancel', 'send']);
  });

  it('keeps every non-radio stop, in order', () => {
    expect(ids([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual(['a', 'b', 'c']);
  });

  it('collapses each group independently', () => {
    const items: Stop[] = [
      { id: 'a1', radioGroup: 'a' },
      { id: 'a2', radioGroup: 'a', checked: true },
      { id: 'b1', radioGroup: 'b' },
      { id: 'b2', radioGroup: 'b' },
    ];
    expect(ids(items)).toEqual(['a2', 'b1']);
  });

  it('is empty for no items', () => {
    expect(ids([])).toEqual([]);
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

  // The cap the route enforces and the cap the copy quotes were two independent
  // literals, so raising NOTE_MAX_CHARS used to leave the refusal lying.
  it('quotes the note cap the boundary actually enforces', () => {
    expect(reportErrorMessage('INVALID_INPUT')).toContain(String(NOTE_MAX_CHARS));
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

    // The cooldown is keyed on (user, resource, category), so copy that named only
    // the resource read as "this row is blocked" — false, and it talks a learner
    // out of reporting the second, different defect they were about to file.
    it('names the problem scope, the resource scope and the remaining wait', () => {
      expect(message(7 * 60_000)).toBe(
        'You already reported this problem with this resource — you can report a different problem now, or this one again in 7 minutes.'
      );
    });

    it('rounds a partial minute up rather than saying zero', () => {
      expect(message(90_000)).toMatch(/in 2 minutes/);
      expect(message(30_000)).toMatch(/in a minute/);
    });

    it('degrades to a vaguer sentence when the wait is missing or junk', () => {
      const vague =
        'You already reported this problem with this resource — you can report a different problem now, or this one again shortly.';
      expect(message(undefined)).toBe(vague);
      expect(message('soon')).toBe(vague);
      expect(message(Number.NaN)).toBe(vague);
      expect(message(-1)).toBe(vague);
    });
  });
});
