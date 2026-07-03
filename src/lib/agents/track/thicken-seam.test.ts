// Unit tests for selectThickenTargets (Budget-fill Block 2): worst-first,
// deduped, capped selection of one thicken cycle's sourcing targets. Pure — no
// DB, no LLM.
import { describe, it, expect, vi } from 'vitest';

// thicken-seam imports @/lib/db and (via source-concept) the vertex leaf; both
// throw at module-eval without env. selectThickenTargets never touches either.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}), geminiFlash: {}, vertexAnthropic: {}, vertexGlobal: {},
}));

import { selectThickenTargets } from '@/lib/agents/track/thicken-seam';
import { TRACK_MAX_THICKEN_CONCEPTS } from '@/lib/config';

const e = (conceptSlug: string) => ({ conceptSlug, reason: `r-${conceptSlug}` });

describe('selectThickenTargets — worst-first, deduped, capped', () => {
  it('teachability holes come before budget-thin, each in composer order', () => {
    const out = selectThickenTargets([e('u1'), e('u2')], [e('t1'), e('t2')]);
    expect(out.map((o) => o.conceptSlug)).toEqual(['u1', 'u2', 't1', 't2']);
  });
  it('budget-thin targets carry the substantial bias; holes do not', () => {
    const out = selectThickenTargets([e('u1')], [e('t1')]);
    expect(out.find((o) => o.conceptSlug === 'u1')?.preferSubstantial).toBe(false);
    expect(out.find((o) => o.conceptSlug === 't1')?.preferSubstantial).toBe(true);
  });
  it('a slug in both lists is a teachability hole (underResourced wins, no double-sourcing)', () => {
    const out = selectThickenTargets([e('x')], [e('x'), e('t1')]);
    expect(out.map((o) => o.conceptSlug)).toEqual(['x', 't1']);
    expect(out[0].preferSubstantial).toBe(false);
  });
  it('caps at TRACK_MAX_THICKEN_CONCEPTS, dropping the least-severe tail', () => {
    const under = Array.from({ length: TRACK_MAX_THICKEN_CONCEPTS - 1 }, (_, i) => e(`u${i}`));
    const thin = [e('t0'), e('t1'), e('t2')];
    const out = selectThickenTargets(under, thin);
    expect(out.length).toBe(TRACK_MAX_THICKEN_CONCEPTS);
    // All holes kept; only the first thin concept fits under the cap.
    expect(out.filter((o) => !o.preferSubstantial).length).toBe(under.length);
    expect(out[out.length - 1].conceptSlug).toBe('t0');
  });
  it('empty inputs → empty selection', () => {
    expect(selectThickenTargets([], [])).toEqual([]);
  });
  it('dedupes within a single list too', () => {
    expect(selectThickenTargets([e('a'), e('a')], []).length).toBe(1);
  });
});
