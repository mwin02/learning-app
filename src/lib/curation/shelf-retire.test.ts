// Unit tests for the provenance-driven shelf retirement (cfml triage).
import { describe, it, expect } from 'vitest';
import { planShelfRetirement, summarizeMoves, type ShelfRow, type Slate } from './shelf-retire';

const SHELF = 'cfml';

const row = (over: Partial<ShelfRow> & { id: string }): ShelfRow => ({
  title: over.id,
  topic: SHELF,
  parentId: null,
  contested: false,
  origin: 'classifier',
  ...over,
});

describe('planShelfRetirement', () => {
  it('moves a container and its subtree to the slate target', () => {
    const rows = [
      row({ id: 'c1' }),
      row({ id: 'k1', parentId: 'c1' }),
      row({ id: 'k2', parentId: 'c1' }),
    ];
    const slate: Slate = new Map([['c1', 'calculus']]);
    const { moves } = planShelfRetirement(rows, slate, SHELF, 'fallback');
    expect(moves.map((m) => m.id).sort()).toEqual(['c1', 'k1', 'k2']);
    expect(moves.every((m) => m.to === 'calculus')).toBe(true);
  });

  it('attributes a child to its container but not the container to itself', () => {
    const rows = [row({ id: 'c1' }), row({ id: 'k1', parentId: 'c1' })];
    const { moves } = planShelfRetirement(rows, new Map([['c1', 'calculus']]), SHELF, 'fb');
    expect(moves.find((m) => m.id === 'c1')!.viaContainer).toBeNull();
    expect(moves.find((m) => m.id === 'k1')!.viaContainer).toBe('c1');
  });

  it('resolves a grandchild through the chain to the nearest slate container', () => {
    const rows = [
      row({ id: 'c1' }),
      row({ id: 'mid', parentId: 'c1' }),
      row({ id: 'leaf', parentId: 'mid' }),
    ];
    const { moves } = planShelfRetirement(rows, new Map([['c1', 'linear-algebra']]), SHELF, 'fb');
    expect(moves.find((m) => m.id === 'leaf')).toMatchObject({
      to: 'linear-algebra',
      viaContainer: 'c1',
    });
  });

  it('LEAVES rows already filed off the shelf untouched, even inside a slate container', () => {
    // The real case: T4b split `eigenvalues-and-eigenvectors` and `convex-optimization`
    // out of these very containers. Inheriting the container verdict would undo that.
    const rows = [
      row({ id: 'c1' }),
      row({ id: 'settled', parentId: 'c1', topic: 'eigenvalues-and-eigenvectors' }),
      row({ id: 'stillHere', parentId: 'c1' }),
    ];
    const { moves, untouched } = planShelfRetirement(
      rows,
      new Map([['c1', 'linear-algebra']]),
      SHELF,
      'fb',
    );
    expect(untouched.map((r) => r.id)).toEqual(['settled']);
    expect(moves.map((m) => m.id).sort()).toEqual(['c1', 'stillHere']);
  });

  it('files a top-level shelf row under the fallback', () => {
    const rows = [row({ id: 'loose' })];
    const { moves } = planShelfRetirement(rows, new Map(), SHELF, 'calculus');
    expect(moves).toEqual([
      expect.objectContaining({ id: 'loose', to: 'calculus', viaContainer: null }),
    ]);
  });

  it('reports a row already on its target as a no-op rather than a move', () => {
    const rows = [row({ id: 'c1', topic: SHELF }), row({ id: 'k1', parentId: 'c1' })];
    // Slate points at the shelf itself — degenerate, but it must not emit a self-move.
    const { moves, noop } = planShelfRetirement(rows, new Map([['c1', SHELF]]), SHELF, 'fb');
    expect(moves).toEqual([]);
    expect(noop.map((r) => r.id).sort()).toEqual(['c1', 'k1']);
  });

  it('CLEARS contested when a container verdict decided the row', () => {
    // The operator naming what the container is IS the review — the doubt was "this
    // should not be on the shelf", and the move answers it.
    const rows = [row({ id: 'c1' }), row({ id: 'k1', parentId: 'c1', contested: true })];
    const { moves } = planShelfRetirement(rows, new Map([['c1', 'calculus']]), SHELF, 'fb');
    const k1 = moves.find((m) => m.id === 'k1')!;
    expect(k1.contested).toBe(false);
    expect(k1.operatorDecided).toBe(true);
  });

  it('PRESERVES contested when only the fallback decided the row', () => {
    // A policy default is not a judgement — nobody looked, so the drain still owes it one.
    const rows = [
      row({ id: 'doubted', contested: true }),
      row({ id: 'settled2', contested: false }),
    ];
    const { moves } = planShelfRetirement(rows, new Map(), SHELF, 'calculus');
    expect(moves.find((m) => m.id === 'doubted')).toMatchObject({
      contested: true,
      operatorDecided: false,
    });
    expect(moves.find((m) => m.id === 'settled2')!.contested).toBe(false);
  });

  it('never manufactures doubt on a row that had none', () => {
    const rows = [row({ id: 'clean', contested: false })];
    const { moves } = planShelfRetirement(rows, new Map(), SHELF, 'calculus');
    expect(moves[0].contested).toBe(false);
  });

  it('re-run: settles a row THIS pass already moved but left contested', () => {
    const rows = [
      row({ id: 'c1', topic: 'calculus', origin: 'review' }),
      row({ id: 'k1', parentId: 'c1', topic: 'calculus', origin: 'review', contested: true }),
    ];
    const { moves, settles } = planShelfRetirement(
      rows,
      new Map([['c1', 'calculus']]),
      SHELF,
      'fb',
    );
    expect(moves).toEqual([]);
    expect(settles).toEqual([
      expect.objectContaining({ id: 'k1', to: 'calculus', contested: false }),
    ]);
  });

  it("re-run: does NOT settle another pass's row sitting in the same subtree", () => {
    // T4b's splits carry origin `classifier`, not `review` — they must stay untouched
    // even when contested, or this pass silently adjudicates work it never looked at.
    const rows = [
      row({ id: 'c1', topic: 'linear-algebra', origin: 'review' }),
      row({
        id: 'theirs',
        parentId: 'c1',
        topic: 'eigenvalues-and-eigenvectors',
        origin: 'classifier',
        contested: true,
      }),
    ];
    const { settles, untouched } = planShelfRetirement(
      rows,
      new Map([['c1', 'linear-algebra']]),
      SHELF,
      'fb',
    );
    expect(settles).toEqual([]);
    // `theirs` must be left alone. `c1` also lands here — it is this pass's own row with
    // nothing left to do (already on target, already uncontested), and "untouched"
    // doubles as the no-action bucket.
    expect(untouched.map((r) => r.id)).toContain('theirs');
  });

  it('survives a cyclic parent chain instead of hanging', () => {
    const rows = [
      row({ id: 'a', parentId: 'b' }),
      row({ id: 'b', parentId: 'a' }),
    ];
    const { moves } = planShelfRetirement(rows, new Map(), SHELF, 'calculus');
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.to === 'calculus')).toBe(true);
  });

  it('summarizes destinations', () => {
    const rows = [
      row({ id: 'c1' }),
      row({ id: 'k1', parentId: 'c1' }),
      row({ id: 'c2' }),
      row({ id: 'loose' }),
    ];
    const slate: Slate = new Map([
      ['c1', 'calculus'],
      ['c2', 'linear-algebra'],
    ]);
    const { moves } = planShelfRetirement(rows, slate, SHELF, 'calculus');
    expect(summarizeMoves(moves)).toEqual(
      new Map([
        ['calculus', 3],
        ['linear-algebra', 1],
      ]),
    );
  });
});
