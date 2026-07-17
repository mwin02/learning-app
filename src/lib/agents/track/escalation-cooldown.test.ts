import { describe, it, expect } from 'vitest';
import { RemediationState } from '@prisma/client';
import { shouldFastFailEscalated, type TerminalJobSnapshot } from '@/lib/agents/track/escalation-cooldown';

const NOW = new Date('2026-07-17T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const COOLDOWN = 24 * HOUR;

function job(overrides: Partial<TerminalJobSnapshot> = {}): TerminalJobSnapshot {
  return {
    state: RemediationState.escalated,
    updatedAt: new Date(NOW.getTime() - HOUR),
    escalatedConceptSlugs: ['tensors', 'eigenvalues'],
    ...overrides,
  };
}

describe('shouldFastFailEscalated', () => {
  it('fast-fails when current holes equal a fresh escalation', () => {
    expect(shouldFastFailEscalated(['tensors', 'eigenvalues'], job(), NOW, COOLDOWN)).toBe(true);
  });

  it('fast-fails when current holes are a strict subset of the escalated set', () => {
    expect(shouldFastFailEscalated(['tensors'], job(), NOW, COOLDOWN)).toBe(true);
  });

  it('does not fast-fail with no prior terminal job', () => {
    expect(shouldFastFailEscalated(['tensors'], null, NOW, COOLDOWN)).toBe(false);
  });

  it('does not fast-fail when a hole is outside the escalated set (new information)', () => {
    expect(shouldFastFailEscalated(['tensors', 'new-hole'], job(), NOW, COOLDOWN)).toBe(false);
  });

  it('does not fast-fail once the escalation is older than the cool-down', () => {
    const stale = job({ updatedAt: new Date(NOW.getTime() - COOLDOWN) });
    expect(shouldFastFailEscalated(['tensors'], stale, NOW, COOLDOWN)).toBe(false);
  });

  it('fast-fails just inside the cool-down boundary', () => {
    const fresh = job({ updatedAt: new Date(NOW.getTime() - COOLDOWN + 1) });
    expect(shouldFastFailEscalated(['tensors'], fresh, NOW, COOLDOWN)).toBe(true);
  });

  it('does not fast-fail when the latest terminal job succeeded', () => {
    expect(shouldFastFailEscalated(['tensors'], job({ state: RemediationState.succeeded }), NOW, COOLDOWN)).toBe(false);
  });

  it('does not fast-fail when the latest terminal job failed (errored run, not an escalation)', () => {
    expect(shouldFastFailEscalated(['tensors'], job({ state: RemediationState.failed }), NOW, COOLDOWN)).toBe(false);
  });

  it('does not fast-fail with zero holes (the no-holes exit owns that case)', () => {
    expect(shouldFastFailEscalated([], job(), NOW, COOLDOWN)).toBe(false);
  });
});
