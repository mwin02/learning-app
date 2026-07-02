// Unit tests for planProgram + buildDecomposePrompt (Phase 2.75b program plan pass).
// Pure fixtures with stubbed decompose + gate seams — no LLM, no DB. Migrated from
// scripts/verify-program-plan.ts (R1).
//
// Asserts the plan wiring: prompt grounds on library topics + anti-list, the gate drops
// out-of-domain topics, a gate THROW drops only that topic, canonical-slug dedup keeps
// the higher weight without downgrading a core tier, and the all-non-positive-weights
// budget fallback still spends the full budget.
import { describe, it, expect, vi } from 'vitest';
import { PriorityTier } from '@prisma/client';

// planProgram's default seams (the real Gemini decompose + topic gate) pull in the
// Vertex model and the Prisma client, both of which throw at MODULE-EVAL time when their
// env vars are absent (GOOGLE_VERTEX_PROJECT / DATABASE_URL). These tests inject their
// own decompose + gate, so that code never runs — but the import graph still evaluates
// those modules. Stub the two leaf modules so the unit project stays pure and runnable
// without .env.local (the `test` = unit safe-default). If a test ever exercises the real
// seams, it belongs in the integration project, not here.
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { planProgram, buildDecomposePrompt, type ProposedTopic } from '@/lib/agents/program/plan';
import type { TopicGateResult } from '@/lib/agents/topic-gate';

const proposed = (over: Partial<ProposedTopic>): ProposedTopic => ({
  topic: 'x',
  weight: 1,
  priorityTier: 'core',
  phaseLabel: 'P1',
  orderHint: 1,
  rationale: 'r',
  ...over,
});
// A stub gate: slugify the label; reject anything containing "cooking".
const stubGate = async (topic: string): Promise<TopicGateResult> => {
  if (topic.toLowerCase().includes('cooking')) return { valid: false, reason: 'out of domain' };
  return { valid: true, canonical: topic.toLowerCase().replace(/\s+/g, '-'), subject: 'cs' };
};

describe('buildDecomposePrompt — grounds on existing library topics + anti-list', () => {
  const p = buildDecomposePrompt(
    { goal: 'ml prep', totalHoursPerWeek: 8, totalWeeks: 10, antiList: ['leetcode'] },
    ['calculus', 'linear-algebra', 'python'],
  );

  it('lists existing library topics', () => {
    expect(p).toContain('calculus, linear-algebra, python');
  });
  it('instructs no-split', () => {
    expect(p.toLowerCase()).toContain('never split them into sub-parts');
  });
  it('includes anti-list exclusion', () => {
    expect(p).toContain('EXCLUDE');
    expect(p).toContain('leetcode');
  });
  it('handles an empty library', () => {
    const empty = buildDecomposePrompt({ goal: 'g', totalHoursPerWeek: 4, totalWeeks: 6 }, []);
    expect(empty).toContain('TOPICS ALREADY IN THE LIBRARY: (none yet)');
  });
});

describe('planProgram — gate drops out-of-domain topics', () => {
  it('drops Cooking and plans only Python', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 10, totalWeeks: 10 },
      {
        decompose: async () => [
          proposed({ topic: 'Python', weight: 3 }),
          proposed({ topic: 'Cooking', weight: 2 }),
        ],
        gate: stubGate,
      },
    );
    expect(plan.droppedByGate.length).toBe(1);
    expect(plan.droppedByGate[0].topic).toBe('Cooking');
    expect(plan.topics.length).toBe(1);
    expect(plan.topics[0].key).toBe('python');
  });
});

describe('planProgram — a gate THROW drops only that topic, not the program', () => {
  it('calls the injected gate once and forms the program from the survivor', async () => {
    let calls = 0;
    // Throws every call. planProgram no longer wraps the gate in its own retry — the
    // one-shot retry now lives inside validateTopic (the real gate), which the injected
    // stub bypasses — so planProgram calls the injected gate exactly once.
    const flakyGate = async (topic: string): Promise<TopicGateResult> => {
      if (topic === 'flaky') {
        calls++;
        throw new Error('No object generated');
      }
      return { valid: true, canonical: topic.toLowerCase(), subject: 'cs' };
    };
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 10, totalWeeks: 10 },
      {
        decompose: async () => [proposed({ topic: 'python', weight: 3 }), proposed({ topic: 'flaky', weight: 2 })],
        gate: flakyGate,
      },
    );
    expect(calls).toBe(1);
    expect(plan.droppedByGate.some((d) => d.topic === 'flaky')).toBe(true);
    expect(plan.topics.length).toBe(1);
    expect(plan.topics[0].key).toBe('python');
  });
});

describe('planProgram — two labels → same canonical collapse (higher weight wins)', () => {
  it('dedups to 2 topics and keeps the higher weight on the merged slot', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => [
          proposed({ topic: 'linear algebra', weight: 2, orderHint: 1 }),
          proposed({ topic: 'Linear Algebra', weight: 8, orderHint: 2 }),
          proposed({ topic: 'calculus', weight: 4, orderHint: 3 }),
        ],
        gate: stubGate,
      },
    );
    expect(plan.topics.length).toBe(2);
    const la = plan.topics.find((t) => t.key === 'linear-algebra');
    expect(la?.weight).toBe(8);
  });
});

describe('planProgram — dedup keeps higher weight but never downgrades a core tier', () => {
  it('adopts the higher weight while the merged slot stays core', async () => {
    // Same canonical from two labels where the higher-weight proposal is nice_to_have
    // and the lower-weight one is core. The merged slot must stay core (else a core need
    // becomes budget-droppable), while still adopting the higher weight.
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => [
          proposed({ topic: 'python', weight: 3, priorityTier: 'core', orderHint: 1 }),
          proposed({ topic: 'Python', weight: 9, priorityTier: 'nice_to_have', orderHint: 2 }),
        ],
        gate: stubGate,
      },
    );
    const py = plan.topics.find((t) => t.key === 'python');
    expect(py?.weight).toBe(9);
    expect(py?.priorityTier).toBe(PriorityTier.core);
  });
});

describe('planProgram — all-weights-non-positive still spends the full budget', () => {
  it('keeps all topics and Σ hoursPerWeek === totalHoursPerWeek', async () => {
    // A degenerate decomposition: every weight ≤ 0 (schema permits it). Without the
    // even-split fallback the above-floor remainder would vanish (each topic = floor).
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 10, totalWeeks: 8 },
      {
        decompose: async () => [
          proposed({ topic: 'python', weight: 0, orderHint: 1 }),
          proposed({ topic: 'calculus', weight: 0, orderHint: 2 }),
          proposed({ topic: 'statistics', weight: -5, orderHint: 3 }),
        ],
        gate: stubGate,
      },
    );
    const total = plan.topics.reduce((s, t) => s + t.hoursPerWeek, 0);
    expect(plan.topics.length).toBe(3);
    expect(total).toBe(10);
  });
});
