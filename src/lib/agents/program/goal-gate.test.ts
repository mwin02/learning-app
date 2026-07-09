// Unit tests for validateGoal (goal-domain gate, Block 1). The classifier seam is
// injected, so these run with no LLM and no DB — they exercise the gate's
// accept/reject/coercion + the module's untouched retry contract only indirectly
// (the retry lives in defaultClassify, which is never called here). getModel is
// stubbed so importing the module (which pulls in @/lib/ai/models) stays secret-free
// per the CLAUDE.md module-eval note, even though the injected classify never calls it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

import { validateGoal, type GoalClassifier } from '@/lib/agents/program/goal-gate';

describe('validateGoal', () => {
  it('accepts an in-domain goal', async () => {
    const classify: GoalClassifier = async () => ({ valid: true, reason: null });
    expect(await validateGoal('learn linear algebra', null, { classify })).toEqual({ valid: true });
  });

  it('rejects an off-domain goal, surfacing the trimmed reason', async () => {
    const classify: GoalClassifier = async () => ({
      valid: false,
      reason: '  dog grooming is outside math/science/cs  ',
    });
    expect(await validateGoal('become a champion dog groomer', null, { classify })).toEqual({
      valid: false,
      reason: 'dog grooming is outside math/science/cs',
    });
  });

  it('falls back to a placeholder reason when the classifier rejects without one', async () => {
    const classify: GoalClassifier = async () => ({ valid: false, reason: null });
    const result = await validateGoal('asdfghjkl', null, { classify });
    expect(result).toEqual({ valid: false, reason: 'goal rejected without explanation' });
  });

  it('treats a whitespace-only reason as no reason', async () => {
    const classify: GoalClassifier = async () => ({ valid: false, reason: '   ' });
    const result = await validateGoal('nonsense', null, { classify });
    expect(result).toEqual({ valid: false, reason: 'goal rejected without explanation' });
  });

  it('passes goal and background through to the classifier verbatim', async () => {
    const seen: Array<[string, string | null]> = [];
    const classify: GoalClassifier = async (goal, background) => {
      seen.push([goal, background]);
      return { valid: true, reason: null };
    };
    await validateGoal('learn calculus', 'rusty high-school math', { classify });
    expect(seen).toEqual([['learn calculus', 'rusty high-school math']]);
  });

  it('defaults background to null when omitted', async () => {
    let seenBackground: string | null = 'unset';
    const classify: GoalClassifier = async (_goal, background) => {
      seenBackground = background;
      return { valid: true, reason: null };
    };
    await validateGoal('learn python', undefined, { classify });
    expect(seenBackground).toBeNull();
  });
});
