// Unit tests for the pending-review queue's provenance labels (Q9). Pure — the
// only import that reaches Prisma is a type, so no stub is needed.

import { describe, it, expect } from 'vitest';
import { durationLabel, filingLabel } from '@/lib/curation/pending-review-view';
import type { FilingProvenance } from '@/lib/curation/pending-review';

const filing = (over: Partial<FilingProvenance> = {}): FilingProvenance => ({
  topic: 'linear-algebra',
  origin: 'classifier',
  relevance: 0.82,
  contested: false,
  ...over,
});

describe('durationLabel', () => {
  it('shows the number and its source together', () => {
    expect(durationLabel(45, 'api')).toEqual({ text: '45m · api', unverified: false });
  });

  it('names a missing duration rather than rendering an empty value', () => {
    expect(durationLabel(null, 'unknown').text).toBe('no duration · unknown');
  });

  // The Q9 point: a hand-measured value must be distinguishable from both a
  // scraper's number and an unmeasured one.
  it('treats a reviewer measurement as verified and labels it distinctly', () => {
    const label = durationLabel(12, 'reviewer');
    expect(label).toEqual({ text: '12m · reviewer', unverified: false });
    expect(label.text).not.toContain('extracted');
  });

  it('flags estimated and unknown as unverified', () => {
    expect(durationLabel(20, 'estimated').unverified).toBe(true);
    expect(durationLabel(20, 'unknown').unverified).toBe(true);
  });

  // A number carrying `unknown` is the exact population Q10 backfills — it must
  // read as unverified even though it looks like a measurement.
  it('flags a number stored with unknown provenance, not just a null', () => {
    expect(durationLabel(20, 'unknown')).toEqual({ text: '20m · unknown', unverified: true });
  });
});

describe('filingLabel', () => {
  it('renders topic, origin and relevance', () => {
    expect(filingLabel(filing())).toEqual({
      text: 'linear-algebra · classifier · rel 0.82',
      unverified: false,
    });
  });

  it('flags the unmeasured origins', () => {
    expect(filingLabel(filing({ origin: 'inherited' })).unverified).toBe(true);
    expect(filingLabel(filing({ origin: 'discovery' })).unverified).toBe(true);
  });

  it('treats a human filing as verified', () => {
    expect(filingLabel(filing({ origin: 'review' })).unverified).toBe(false);
  });

  it('flags a contested membership and says so', () => {
    const label = filingLabel(filing({ contested: true }));
    expect(label.unverified).toBe(true);
    expect(label.text).toContain('contested');
  });

  it('reports a missing primary membership as its own condition', () => {
    expect(filingLabel(null)).toEqual({
      text: 'no primary topic membership',
      unverified: true,
    });
  });
});
