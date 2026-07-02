// Unit tests for the pure ordering helpers topoSort + layerBySlug (Phase 2.5e-1).
// No DB, no LLM. Migrated from scripts/verify-track-plan.ts (R2).
import { describe, it, expect } from 'vitest';
import { topoSort, layerBySlug, type OrderEdge } from '@/lib/agents/map/order';

// Diamond: a → b, a → c, b → d, c → d. Plus isolated node `e`.
const concepts = ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ slug }));
const edges: OrderEdge[] = [
  { fromSlug: 'a', toSlug: 'b' },
  { fromSlug: 'a', toSlug: 'c' },
  { fromSlug: 'b', toSlug: 'd' },
  { fromSlug: 'c', toSlug: 'd' },
];

describe('topoSort', () => {
  const order = topoSort(concepts, edges);
  const pos = new Map(order.map((s, i) => [s, i]));

  it('contains every concept', () => {
    expect(order.length).toBe(5);
    expect(new Set(order).size).toBe(5);
  });
  it('respects every edge (from before to)', () => {
    expect(edges.every((e) => pos.get(e.fromSlug)! < pos.get(e.toSlug)!)).toBe(true);
  });
  it('isolated node present', () => expect(order).toContain('e'));
  it('deterministic across runs', () => expect(topoSort(concepts, edges)).toEqual(order));
  it('deterministic tie-break (a first, then b before c)', () => {
    expect(order[0]).toBe('a');
    expect(pos.get('b')!).toBeLessThan(pos.get('c')!);
  });

  // Priority tie-break (Phase 2.5e order fix): among prereq-free siblings the priority
  // rank wins, but the DAG always wins over priority, and unranked slugs fall back to
  // lexical, last.
  describe('priority tie-break', () => {
    const prio = new Map([['c', 0], ['b', 1], ['a', 2], ['d', 3]]);
    const pOrder = topoSort(concepts, edges, prio);
    const pp = new Map(pOrder.map((s, i) => [s, i]));

    it('priority breaks sibling ties (c before b)', () => expect(pp.get('c')!).toBeLessThan(pp.get('b')!));
    it('DAG still wins over priority (a first despite rank 2)', () => expect(pOrder[0]).toBe('a'));
    it('DAG still wins over priority (d after both b and c despite rank 3)', () => {
      expect(pp.get('d')!).toBeGreaterThan(pp.get('b')!);
      expect(pp.get('d')!).toBeGreaterThan(pp.get('c')!);
    });
    it('respects every edge under priority', () =>
      expect(edges.every((e) => pp.get(e.fromSlug)! < pp.get(e.toSlug)!)).toBe(true));
    it('deterministic under priority', () => expect(topoSort(concepts, edges, prio)).toEqual(pOrder));

    it('unranked falls back to lexical, after ranked (c before b)', () => {
      const partial = topoSort(concepts, edges, new Map([['c', 0]]));
      const ppart = new Map(partial.map((s, i) => [s, i]));
      expect(ppart.get('c')!).toBeLessThan(ppart.get('b')!);
    });
    it('empty priority == lexical default (back-compat)', () =>
      expect(topoSort(concepts, edges, new Map())).toEqual(order));
  });

  it('cycle does not hang, all nodes appended', () => {
    const cyc = topoSort([{ slug: 'a' }, { slug: 'b' }], [
      { fromSlug: 'a', toSlug: 'b' },
      { fromSlug: 'b', toSlug: 'a' },
    ]);
    expect(cyc.length).toBe(2);
    expect(new Set(cyc).size).toBe(2);
  });
});

describe('layerBySlug', () => {
  const layers = layerBySlug(concepts, edges);

  it('root layer 0', () => expect(layers.get('a')).toBe(0));
  it('direct deps layer 1', () => {
    expect(layers.get('b')).toBe(1);
    expect(layers.get('c')).toBe(1);
  });
  it('diamond sink layer 2 (longest path)', () => expect(layers.get('d')).toBe(2));
  it('isolated node layer 0', () => expect(layers.get('e')).toBe(0));
});
