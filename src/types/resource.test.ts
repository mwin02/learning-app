import { describe, it, expect } from 'vitest';
import { relatedTopics, TOPIC_RELATIONS, TOPIC_SLUGS } from '@/types/resource';

// Topic filing T4d: relatedTopics is DIRECTED. These tests exist because the previous
// implementation did a reverse scan over TOPIC_RELATIONS, so every declaration bought
// both directions — the regression to guard against is that scan coming back, which
// would silently re-widen `calculus`, `sql` and `python` and undo the narrowing.
describe('relatedTopics (directed)', () => {
  it('includes the topic itself', () => {
    expect(relatedTopics('calculus')).toContain('calculus');
    expect(relatedTopics('linear-algebra')).toEqual(['linear-algebra']);
  });

  it('returns just the topic when it declares no outbound edges', () => {
    // Edgeless by design — the four topics T4d measured as delta-0.
    for (const t of ['discrete-mathematics', 'linear-algebra', 'probability-and-statistics', 'physics-mechanics']) {
      expect(relatedTopics(t)).toEqual([t]);
    }
  });

  it('follows a declared edge forward', () => {
    expect(relatedTopics('precalculus')).toEqual(expect.arrayContaining(['precalculus', 'calculus']));
    expect(relatedTopics('python-data-ml')).toEqual(
      expect.arrayContaining(['python-data-ml', 'python', 'machine-learning']),
    );
  });

  it('does NOT follow an edge backward — the T4d narrowing', () => {
    // precalculus -> calculus is declared; the reverse was dropped on measurement
    // (4 of 132 candidate slots churned, 0 attached teaches rows lost).
    expect(relatedTopics('calculus')).toEqual(['calculus']);
    // data-structures-algorithms -> python is declared; the reverse was actively harmful.
    expect(relatedTopics('python')).not.toContain('data-structures-algorithms');
    // neither direction of sql <-> python-data-ml survived.
    expect(relatedTopics('sql')).toEqual(['sql']);
    expect(relatedTopics('python-data-ml')).not.toContain('sql');
    // no Path, never exercised.
    expect(relatedTopics('machine-learning')).toEqual(['machine-learning']);
    expect(relatedTopics('javascript')).toEqual(['javascript']);
  });

  it('declares the reverse explicitly where it is still wanted', () => {
    // python -> python-data-ml came free under the symmetric closure and carries 5 real
    // attachments, so T4d had to declare it rather than inherit it.
    expect(relatedTopics('python')).toContain('python-data-ml');
  });

  it('is deduplicated and never contains the topic twice', () => {
    for (const t of Object.keys(TOPIC_RELATIONS)) {
      const out = relatedTopics(t);
      expect(new Set(out).size).toBe(out.length);
    }
  });

  it('has no self-edge in the table (relatedTopics adds the topic itself)', () => {
    for (const [k, vs] of Object.entries(TOPIC_RELATIONS)) expect(vs).not.toContain(k);
  });

  it('never widens a curated topic into an unknown slug without a deliberate entry', () => {
    // Every widening target must be a curated slug or an agent-minted slug we know
    // about — a typo here silently produces an empty widening rather than an error.
    const known = new Set<string>([...TOPIC_SLUGS, 'javascript']);
    for (const vs of Object.values(TOPIC_RELATIONS)) {
      for (const t of vs) expect(known).toContain(t);
    }
  });
});
