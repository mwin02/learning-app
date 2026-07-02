// Unit tests for group-into-sections.ts (Phase 2.5e track sections) — the
// contiguity-by-construction invariant + every repair path. No LLM, no DB. Migrated
// from the PURE half of scripts/verify-sectioner.ts (R2); the live build/section half
// stays in that script.
import { describe, it, expect } from 'vitest';
import { groupIntoSections } from '@/lib/agents/track/group-into-sections';

// Assert a section set partitions [orders] into contiguous, in-order, gapless runs.
function assertContiguousPartition(
  orders: number[],
  sections: { orderInTrack: number; lessonOrders: number[] }[],
) {
  const flat = sections.flatMap((s) => s.lessonOrders);
  expect(flat).toEqual(orders); // covers every lesson exactly once
  expect(sections.every((s, i) => s.orderInTrack === i + 1)).toBe(true); // numbered 1..k
  expect(sections.every((s) => s.lessonOrders.length > 0)).toBe(true); // no empty section
  expect(sections.every((s) => s.lessonOrders.every((o, i) => i === 0 || o > s.lessonOrders[i - 1]))).toBe(true); // ascending + contiguous
}

const orders = [1, 2, 3, 4, 5, 6];

describe('groupIntoSections — happy path: three clean chapters', () => {
  const r = groupIntoSections({
    lessonOrders: orders,
    boundaries: [
      { startsAtLesson: 1, title: 'A', intro: 'a' },
      { startsAtLesson: 3, title: 'B', intro: 'b' },
      { startsAtLesson: 5, title: 'C', intro: 'c' },
    ],
    fallbackTitle: 'T',
  });

  it('partitions contiguously into 3 sections with boundaries respected', () => {
    assertContiguousPartition(orders, r.sections);
    expect(r.sections.length).toBe(3);
    expect(r.sections[1].lessonOrders).toEqual([3, 4]);
  });
});

describe("groupIntoSections — model didn't start at lesson 1 → clamp, no orphan lead-in", () => {
  const r = groupIntoSections({
    lessonOrders: orders,
    boundaries: [
      { startsAtLesson: 3, title: 'B', intro: 'b' },
      { startsAtLesson: 5, title: 'C', intro: 'c' },
    ],
    fallbackTitle: 'T',
  });

  it('first section absorbs the lead-in 1,2', () => {
    assertContiguousPartition(orders, r.sections);
    expect(r.sections[0].lessonOrders).toEqual([1, 2, 3, 4]);
  });
});

describe('groupIntoSections — out-of-range + duplicate + unsorted boundaries are repaired', () => {
  const r = groupIntoSections({
    lessonOrders: orders,
    boundaries: [
      { startsAtLesson: 4, title: 'B', intro: 'b' },
      { startsAtLesson: 99, title: 'X', intro: 'x' },
      { startsAtLesson: 1, title: 'A', intro: 'a' },
      { startsAtLesson: 4, title: 'Bdup', intro: 'b2' },
    ],
    fallbackTitle: 'T',
  });

  it('drops the dup + oob boundary and warns', () => {
    assertContiguousPartition(orders, r.sections);
    expect(r.sections.length).toBe(2);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('groupIntoSections — no usable boundaries → single fallback chapter', () => {
  const r = groupIntoSections({ lessonOrders: orders, boundaries: [], fallbackTitle: 'Whole Course' });

  it('renders one chapter covering everything', () => {
    expect(r.sections.length).toBe(1);
    expect(r.sections[0].title).toBe('Whole Course');
    assertContiguousPartition(orders, r.sections);
  });
});
