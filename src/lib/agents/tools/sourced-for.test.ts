// Unit tests for deriveSourcedForPairs — the pure pair-derivation half of the
// Block 1 provenance write (the DB write itself is covered by
// tests/integration/resource-sourced-for.test.ts).
import { describe, it, expect } from 'vitest';
import { deriveSourcedForPairs, type SourcedForRow } from './sourced-for';

const row = (resourceId: string | null, decompositionStatus: SourcedForRow['decompositionStatus']): SourcedForRow => ({
  resourceId,
  decompositionStatus,
});

describe('deriveSourcedForPairs', () => {
  it('derives nothing without a sourcing concept (topic-level entry point)', () => {
    const rows = [row('r1', 'human_review')];
    expect(deriveSourcedForPairs(null, rows)).toEqual([]);
    expect(deriveSourcedForPairs(undefined, rows)).toEqual([]);
  });

  it('derives a pair for every non-atomic decomposition status', () => {
    const rows = [
      row('r1', 'pending'),
      row('r2', 'human_review'),
      row('r3', 'unsupported'),
      row('r4', 'decomposed'),
    ];
    expect(deriveSourcedForPairs('c1', rows)).toEqual([
      { resourceId: 'r1', conceptId: 'c1' },
      { resourceId: 'r2', conceptId: 'c1' },
      { resourceId: 'r3', conceptId: 'c1' },
      { resourceId: 'r4', conceptId: 'c1' },
    ]);
  });

  it('skips atomic rows — they are judged+attached in the same run', () => {
    expect(deriveSourcedForPairs('c1', [row('r1', 'atomic'), row('r2', 'pending')])).toEqual([
      { resourceId: 'r2', conceptId: 'c1' },
    ]);
  });

  it('skips rows with no addressable parent (failed transaction)', () => {
    expect(deriveSourcedForPairs('c1', [row(null, null), row(null, 'pending')])).toEqual([]);
  });

  it('dedupes a resource seen twice within one run', () => {
    expect(deriveSourcedForPairs('c1', [row('r1', 'pending'), row('r1', 'pending')])).toEqual([
      { resourceId: 'r1', conceptId: 'c1' },
    ]);
  });

  it('derives nothing from an empty run', () => {
    expect(deriveSourcedForPairs('c1', [])).toEqual([]);
  });
});
