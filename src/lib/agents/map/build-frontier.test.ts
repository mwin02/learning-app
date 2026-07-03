import { describe, it, expect, vi, beforeEach } from 'vitest';

// build-frontier imports frontier-author → @/lib/ai/models, which validates env
// at module-eval; stub the model layer so the unit tests stay secret-free, and
// stub the author itself so the orchestrator tests drive it deterministically.
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0, modelId: 'stub' }),
}));
vi.mock('@/lib/agents/map/frontier-author', () => ({ authorFrontier: vi.fn() }));

import { authorFrontier, type AuthoredFrontierConcept } from '@/lib/agents/map/frontier-author';
import { FRONTIER_MAX_CONCEPTS, FRONTIER_MAX_REPAIRS } from '@/lib/config';
import {
  sanitizeFrontier,
  frontierCycle,
  breakCycles,
  buildFrontier,
  type FrontierPlan,
} from '@/lib/agents/map/build-frontier';

const mockAuthor = vi.mocked(authorFrontier);

const spine = new Set(['limits', 'derivatives', 'integrals']);

const node = (slug: string, prereqs: string[] = []): AuthoredFrontierConcept => ({
  slug,
  title: `Title of ${slug}`,
  prerequisiteSlugs: prereqs,
});

describe('sanitizeFrontier', () => {
  it('keeps valid concepts and builds edges from prerequisiteSlugs', () => {
    const plan = sanitizeFrontier(spine, [node('lhopitals-rule', ['limits', 'derivatives'])]);
    expect(plan.concepts).toEqual([{ slug: 'lhopitals-rule', title: 'Title of lhopitals-rule' }]);
    expect(plan.edges).toEqual([
      { fromSlug: 'limits', toSlug: 'lhopitals-rule' },
      { fromSlug: 'derivatives', toSlug: 'lhopitals-rule' },
    ]);
  });

  it('drops malformed slugs, short titles, and duplicates (first wins)', () => {
    const plan = sanitizeFrontier(spine, [
      node('Bad Slug'),
      { slug: 'thin', title: 'x', prerequisiteSlugs: [] },
      node('taylor-series'),
      node('taylor-series', ['limits']),
    ]);
    expect(plan.concepts.map((c) => c.slug)).toEqual(['taylor-series']);
    expect(plan.edges).toEqual([]);
  });

  it('drops concepts colliding with an existing map slug', () => {
    const plan = sanitizeFrontier(spine, [node('derivatives'), node('taylor-series')]);
    expect(plan.concepts.map((c) => c.slug)).toEqual(['taylor-series']);
  });

  it('filters invented, self-referencing, and duplicate prerequisites but keeps the concept', () => {
    const plan = sanitizeFrontier(spine, [
      node('taylor-series', ['taylor-series', 'made-up-slug', 'limits', 'limits']),
    ]);
    expect(plan.concepts.map((c) => c.slug)).toEqual(['taylor-series']);
    expect(plan.edges).toEqual([{ fromSlug: 'limits', toSlug: 'taylor-series' }]);
  });

  it('allows frontier→frontier chains, including forward references within the batch', () => {
    const plan = sanitizeFrontier(spine, [
      node('sequences-and-series', ['limits', 'power-series']),
      node('power-series', ['sequences-and-series']),
    ]);
    expect(plan.edges).toContainEqual({ fromSlug: 'power-series', toSlug: 'sequences-and-series' });
    expect(plan.edges).toContainEqual({ fromSlug: 'sequences-and-series', toSlug: 'power-series' });
  });

  it('truncates overflow past FRONTIER_MAX_CONCEPTS and drops edges into truncated nodes', () => {
    const authored = Array.from({ length: FRONTIER_MAX_CONCEPTS + 2 }, (_, i) => node(`extra-${i}`));
    // The last kept node anchors on an overflow node — that prereq must drop too.
    authored[0] = node('extra-0', [`extra-${FRONTIER_MAX_CONCEPTS + 1}`, 'limits']);
    const plan = sanitizeFrontier(spine, authored);
    expect(plan.concepts).toHaveLength(FRONTIER_MAX_CONCEPTS);
    expect(plan.edges).toEqual([{ fromSlug: 'limits', toSlug: 'extra-0' }]);
  });
});

describe('frontierCycle', () => {
  const planOf = (concepts: string[], edges: [string, string][]): FrontierPlan => ({
    concepts: concepts.map((slug) => ({ slug, title: slug })),
    edges: edges.map(([fromSlug, toSlug]) => ({ fromSlug, toSlug })),
  });

  it('returns null for an acyclic plan (edges from existing concepts ignored)', () => {
    const plan = planOf(['a', 'b'], [['limits', 'a'], ['a', 'b']]);
    expect(frontierCycle(plan)).toBeNull();
  });

  it('finds a cycle among new nodes', () => {
    const plan = planOf(['a', 'b'], [['a', 'b'], ['b', 'a']]);
    expect(frontierCycle(plan)).not.toBeNull();
  });
});

describe('breakCycles', () => {
  it('drops edges until acyclic, never dropping a concept', () => {
    const plan: FrontierPlan = {
      concepts: [{ slug: 'a', title: 'a' }, { slug: 'b', title: 'b' }, { slug: 'c', title: 'c' }],
      edges: [
        { fromSlug: 'a', toSlug: 'b' },
        { fromSlug: 'b', toSlug: 'c' },
        { fromSlug: 'c', toSlug: 'a' },
        { fromSlug: 'limits', toSlug: 'a' },
      ],
    };
    const fixed = breakCycles(plan);
    expect(fixed.concepts).toHaveLength(3);
    expect(frontierCycle(fixed)).toBeNull();
    expect(fixed.edges).toContainEqual({ fromSlug: 'limits', toSlug: 'a' });
    expect(fixed.edges.length).toBe(3);
  });
});

describe('buildFrontier', () => {
  const existing = [...spine].map((slug) => ({ slug, title: slug, membership: 'spine' }));

  beforeEach(() => {
    mockAuthor.mockReset();
  });

  it('returns the sanitized plan when the first attempt is acyclic', async () => {
    mockAuthor.mockResolvedValueOnce({ concepts: [node('taylor-series', ['limits'])] });
    const plan = await buildFrontier({ topic: 'calculus', existing });
    expect(plan.concepts.map((c) => c.slug)).toEqual(['taylor-series']);
    expect(mockAuthor).toHaveBeenCalledTimes(1);
    expect(mockAuthor.mock.calls[0][0].repairFeedback).toBeUndefined();
  });

  it('feeds a cycle back as repairFeedback and returns the repaired plan', async () => {
    mockAuthor
      .mockResolvedValueOnce({ concepts: [node('a', ['b']), node('b', ['a'])] })
      .mockResolvedValueOnce({ concepts: [node('a', ['limits']), node('b', ['a'])] });
    const plan = await buildFrontier({ topic: 'calculus', existing });
    expect(mockAuthor).toHaveBeenCalledTimes(2);
    expect(mockAuthor.mock.calls[1][0].repairFeedback).toMatch(/cycle/i);
    expect(frontierCycle(plan)).toBeNull();
    expect(plan.concepts).toHaveLength(2);
  });

  it('breaks cycles deterministically once the repair budget is exhausted', async () => {
    mockAuthor.mockResolvedValue({ concepts: [node('a', ['b']), node('b', ['a'])] });
    const plan = await buildFrontier({ topic: 'calculus', existing });
    expect(mockAuthor).toHaveBeenCalledTimes(FRONTIER_MAX_REPAIRS + 1);
    expect(frontierCycle(plan)).toBeNull();
    expect(plan.concepts).toHaveLength(2);
    expect(plan.edges).toHaveLength(1);
  });

  it('never throws: an author that always fails yields an empty plan', async () => {
    mockAuthor.mockRejectedValue(new Error('vertex 503'));
    const plan = await buildFrontier({ topic: 'calculus', existing });
    expect(mockAuthor).toHaveBeenCalledTimes(FRONTIER_MAX_REPAIRS + 1);
    expect(plan).toEqual({ concepts: [], edges: [] });
  });
});
