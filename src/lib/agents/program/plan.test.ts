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

import {
  planProgram,
  buildDecomposePrompt,
  type ProposedTopic,
  type ProgramDecomposition,
} from '@/lib/agents/program/plan';
import type { TopicGateResult } from '@/lib/agents/topic-gate';

const proposed = (over: Partial<ProposedTopic>): ProposedTopic => ({
  topic: 'x',
  weight: 1,
  priorityTier: 'core',
  phaseLabel: 'P1',
  orderHint: 1,
  rationale: 'r',
  frontierConcepts: [],
  ...over,
});
// Phase 3c: decompose returns { title, description, topics } — wrap topic
// fixtures in a canned program name.
const decomp = (topics: ProposedTopic[]): ProgramDecomposition => ({
  title: 'Test Program',
  description: 'A test program.',
  topics,
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
        decompose: async () => decomp([
          proposed({ topic: 'Python', weight: 3 }),
          proposed({ topic: 'Cooking', weight: 2 }),
        ]),
        gate: stubGate,
        listLibrary: async () => [],
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
        decompose: async () => decomp([proposed({ topic: 'python', weight: 3 }), proposed({ topic: 'flaky', weight: 2 })]),
        gate: flakyGate,
        listLibrary: async () => [],
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
        decompose: async () => decomp([
          proposed({ topic: 'linear algebra', weight: 2, orderHint: 1 }),
          proposed({ topic: 'Linear Algebra', weight: 8, orderHint: 2 }),
          proposed({ topic: 'calculus', weight: 4, orderHint: 3 }),
        ]),
        gate: stubGate,
        listLibrary: async () => [],
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
        decompose: async () => decomp([
          proposed({ topic: 'python', weight: 3, priorityTier: 'core', orderHint: 1 }),
          proposed({ topic: 'Python', weight: 9, priorityTier: 'nice_to_have', orderHint: 2 }),
        ]),
        gate: stubGate,
        listLibrary: async () => [],
      },
    );
    const py = plan.topics.find((t) => t.key === 'python');
    expect(py?.weight).toBe(9);
    expect(py?.priorityTier).toBe(PriorityTier.core);
  });
});

describe('planProgram — dedup tie-break: on EQUAL weight, core beats nice_to_have', () => {
  it("adopts the core proposal's fields (not just its tier) when weights tie", async () => {
    // Same canonical, EQUAL weight. The first (existing) is nice_to_have; the second
    // (candidate) is core. The `candidateWins` tie-break must select the core proposal,
    // so the merged slot carries the CANDIDATE's fields (phaseLabel/rationale), not the
    // nice_to_have's — proving the tie-break, not merely the never-downgrade-tier rule.
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => decomp([
          proposed({ topic: 'python', weight: 5, priorityTier: 'nice_to_have', phaseLabel: 'EXISTING', rationale: 'existing' }),
          proposed({ topic: 'Python', weight: 5, priorityTier: 'core', phaseLabel: 'CANDIDATE', rationale: 'candidate' }),
        ]),
        gate: stubGate,
        listLibrary: async () => [], // F7 Stage 2.5 now always reads the library; keep this unit pure
      },
    );
    const py = plan.topics.find((t) => t.key === 'python');
    expect(py?.priorityTier).toBe(PriorityTier.core);
    expect(py?.phaseLabel).toBe('CANDIDATE');
    expect(py?.rationale).toBe('candidate');
  });
});

describe('planProgram — all-weights-non-positive still spends the full budget', () => {
  it('keeps all topics and Σ hoursPerWeek === totalHoursPerWeek', async () => {
    // A degenerate decomposition: every weight ≤ 0 (schema permits it). Without the
    // even-split fallback the above-floor remainder would vanish (each topic = floor).
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 10, totalWeeks: 8 },
      {
        decompose: async () => decomp([
          proposed({ topic: 'python', weight: 0, orderHint: 1 }),
          proposed({ topic: 'calculus', weight: 0, orderHint: 2 }),
          proposed({ topic: 'statistics', weight: -5, orderHint: 3 }),
        ]),
        gate: stubGate,
        listLibrary: async () => [],
      },
    );
    const total = plan.topics.reduce((s, t) => s + t.hoursPerWeek, 0);
    expect(plan.topics.length).toBe(3);
    expect(total).toBe(10);
  });
});

describe('planProgram — carries the generated title/description through (3c)', () => {
  it('returns the decomposition title/description on the plan', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 10, totalWeeks: 10 },
      {
        decompose: async () => ({
          title: 'Calculus Foundations',
          description: 'Core calculus for STEM coursework.',
          topics: [proposed({ topic: 'calculus', weight: 1 })],
        }),
        gate: stubGate,
        listLibrary: async () => [],
      },
    );
    expect(plan.title).toBe('Calculus Foundations');
    expect(plan.description).toBe('Core calculus for STEM coursework.');
  });
});

describe('planProgram — F7 scoped-topic reconciliation', () => {
  const library = ['calculus', 'python'];
  // Reconciler stub: "<x>-for-<y>" scoped variants remap to their base library topic;
  // anything else is a genuine novelty (null). Only ever runs for canonicals NOT in the
  // library (planProgram short-circuits library topics before calling reconcile).
  const stubReconcile = async (canonical: string): Promise<string | null> => {
    if (canonical === 'calculus-for-machine-learning') return 'calculus';
    if (canonical === 'python-for-data-science') return 'python';
    return null;
  };
  const opts = { gate: stubGate, listLibrary: async () => library, reconcile: stubReconcile };

  it('remaps a scoped variant onto its existing library topic and folds the scope into the rationale', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      { decompose: async () => decomp([proposed({ topic: 'calculus for machine learning', weight: 5 })]), ...opts },
    );
    expect(plan.topics.length).toBe(1);
    expect(plan.topics[0].key).toBe('calculus'); // remapped, not the scoped mint
    expect(plan.topics[0].rationale).toContain('scoped focus within calculus');
  });

  it('passes a genuinely novel topic through untouched', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      { decompose: async () => decomp([proposed({ topic: 'rust', weight: 3 })]), ...opts },
    );
    expect(plan.topics.map((t) => t.key)).toEqual(['rust']);
    expect(plan.topics[0].rationale).not.toContain('scoped focus');
  });

  it('merges a remap that collides with an already-planned topic by weight (never downgrading core)', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => decomp([
          proposed({ topic: 'calculus', weight: 2, priorityTier: 'core', orderHint: 1 }),
          proposed({ topic: 'calculus for machine learning', weight: 8, priorityTier: 'nice_to_have', orderHint: 2 }),
        ]),
        ...opts,
      },
    );
    // Both collapse onto 'calculus': higher weight (8) wins, tier stays core.
    expect(plan.topics.length).toBe(1);
    const cal = plan.topics[0];
    expect(cal.key).toBe('calculus');
    expect(cal.weight).toBe(8);
    expect(cal.priorityTier).toBe(PriorityTier.core);
  });
});

describe('planProgram — frontierConcepts thread through and union on collapse (decomposer Block 3)', () => {
  it('carries a proposal\'s frontierConcepts through gate/reconcile/budget to the allocated topic', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => decomp([
          proposed({ topic: 'machine learning', weight: 3, frontierConcepts: ['reinforcement learning'] }),
          proposed({ topic: 'python', weight: 2, orderHint: 2 }),
        ]),
        gate: stubGate,
        listLibrary: async () => [],
      },
    );
    const ml = plan.topics.find((t) => t.key === 'machine-learning');
    expect(ml?.frontierConcepts).toEqual(['reinforcement learning']);
    expect(plan.topics.find((t) => t.key === 'python')?.frontierConcepts).toEqual([]);
  });

  it('Stage-2 canonical collapse UNIONS frontier lists, winner\'s first, re-capped at MAX_FRONTIER_PER_TOPIC', async () => {
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => decomp([
          // Loser (weight 2): two requests of its own, one shared with the winner.
          proposed({ topic: 'machine learning', weight: 2, orderHint: 1, frontierConcepts: ['transformers', 'reinforcement learning'] }),
          // Winner (weight 8): its list must lead the union.
          proposed({ topic: 'Machine Learning', weight: 8, orderHint: 2, frontierConcepts: ['reinforcement learning'] }),
        ]),
        gate: stubGate,
        listLibrary: async () => [],
      },
    );
    expect(plan.topics.length).toBe(1);
    // Union = winner's ['reinforcement learning'] + loser's new ['transformers', ...],
    // deduped, then sliced to the per-topic cap (2).
    expect(plan.topics[0].frontierConcepts).toEqual(['reinforcement learning', 'transformers']);
  });

  it('Stage-2.5 reconcile collapse unions too (ambiguity #5: at the reconciled map, not only the first dedup)', async () => {
    const stubReconcile = async (canonical: string): Promise<string | null> =>
      canonical === 'calculus-for-machine-learning' ? 'calculus' : null;
    const plan = await planProgram(
      { goal: 'g', totalHoursPerWeek: 12, totalWeeks: 10 },
      {
        decompose: async () => decomp([
          proposed({ topic: 'calculus', weight: 8, orderHint: 1, frontierConcepts: ['tensor calculus'] }),
          // Distinct canonical at Stage 2; remapped onto 'calculus' at Stage 2.5.
          proposed({ topic: 'calculus for machine learning', weight: 2, orderHint: 2, frontierConcepts: ['matrix calculus'] }),
        ]),
        gate: stubGate,
        listLibrary: async () => ['calculus'],
        reconcile: stubReconcile,
      },
    );
    expect(plan.topics.length).toBe(1);
    expect(plan.topics[0].key).toBe('calculus');
    expect(plan.topics[0].frontierConcepts).toEqual(['tensor calculus', 'matrix calculus']);
  });
});
