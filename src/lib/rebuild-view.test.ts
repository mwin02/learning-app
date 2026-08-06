// Unit tests for the rebuild dialog's presentational derivations (R7).

import { describe, it, expect } from 'vitest';
import {
  changeSummary,
  masteryOptions,
  quotaLine,
  rebuildErrorMessage,
  rebuildStatusSchema,
  type Staleness,
} from './rebuild-view';

const base: Staleness = {
  stale: true,
  deprecatedResources: 0,
  changedResources: 0,
  pathChanged: false,
  conceptsCreated: 0,
  inputsEdited: false,
};

describe('changeSummary', () => {
  it('leads with broken resources, counted and pluralised', () => {
    expect(changeSummary({ ...base, deprecatedResources: 3, changedResources: 3 })[0]).toBe(
      '3 resources were removed as broken since this course was built.',
    );
    expect(changeSummary({ ...base, deprecatedResources: 1, changedResources: 1 })[0]).toBe(
      '1 resource was removed as broken since this course was built.',
    );
  });

  it('does not double-count a removed resource as also corrected', () => {
    const lines = changeSummary({ ...base, deprecatedResources: 2, changedResources: 2 });
    expect(lines).toHaveLength(1);
  });

  it('reports the corrected remainder separately', () => {
    const lines = changeSummary({ ...base, deprecatedResources: 1, changedResources: 4 });
    expect(lines[1]).toBe('3 resources have been corrected since then.');
  });

  it('mentions the Path proxy only when nothing concrete changed', () => {
    expect(changeSummary({ ...base, pathChanged: true })).toEqual([
      'This subject has been worked on since your course was built.',
    ]);
    expect(changeSummary({ ...base, pathChanged: true, conceptsCreated: 2 })).toEqual([
      '2 new concepts appeared in this subject since then.',
    ]);
  });

  it('says nothing when nothing changed', () => {
    expect(changeSummary({ ...base, stale: false })).toEqual([]);
  });

  // The invariant the dialog rests on: "is there something to say" and "can you
  // rebuild" come from one decision, so a change line can never sit next to a
  // disabled button (and NOTHING_CHANGED can never sit next to an enabled one).
  // Both shapes below are real rows from the dev DB after R7's tightening —
  // tracks that moved ONLY in the terms that no longer gate a rebuild.
  it('emits no lines for a not-stale track whose Path row was merely touched', () => {
    expect(changeSummary({ ...base, stale: false, pathChanged: true })).toEqual([]);
  });

  it('emits no lines for a not-stale track whose resources were merely corrected', () => {
    expect(changeSummary({ ...base, stale: false, changedResources: 7, pathChanged: true })).toEqual([]);
  });
});

describe('quotaLine', () => {
  it('states the allowance and what is left', () => {
    expect(quotaLine({ used: 1, limit: 3 })).toBe('This uses one of your 3 rebuilds this month — 2 left.');
  });

  it('never shows a negative remainder', () => {
    expect(quotaLine({ used: 5, limit: 3 })).toContain('0 left');
  });
});

describe('rebuildErrorMessage', () => {
  it('gives each R5 refusal its own message', () => {
    const messages = ['ALREADY_REBUILDING', 'FREE_LIMIT_REACHED', 'NOT_STALE', 'NOT_ENROLLED', 'NOT_FOUND'].map(
      (code) => rebuildErrorMessage(code, 3),
    );
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages[0]).toMatch(/already being rebuilt/);
    expect(messages[1]).toMatch(/all 3 rebuilds/);
    expect(messages[2]).toMatch(/Change one of your answers/);
  });

  it('falls back for an unknown code', () => {
    expect(rebuildErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
  });
});

describe('rebuildStatusSchema', () => {
  it('parses the route payload', () => {
    const parsed = rebuildStatusSchema.parse({
      inputs: { goal: null, timeframeWeeks: 8, hoursPerWeek: 5, targetMastery: 'intermediate' },
      staleness: base,
      quota: { allowed: true, used: 0, limit: 3 },
      rebuilding: false,
    });
    expect(parsed.inputs.targetMastery).toBe('intermediate');
  });

  it('rejects a payload missing a staleness term the copy reads', () => {
    const partial = { ...base, deprecatedResources: undefined };
    expect(() =>
      rebuildStatusSchema.parse({
        inputs: { goal: null, timeframeWeeks: null, hoursPerWeek: null, targetMastery: null },
        staleness: partial,
        quota: { allowed: true, used: 0, limit: 3 },
        rebuilding: false,
      }),
    ).toThrow();
  });
});

describe('masteryOptions', () => {
  it('gives every mastery level plain-language wording', () => {
    const options = masteryOptions();
    expect(options).toHaveLength(3);
    for (const o of options) expect(o.label).not.toContain(o.value);
  });
});
