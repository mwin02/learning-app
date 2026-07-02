// Unit tests for the track-build cleanup pass (cleanup-lessons.ts) — the ROLE-PRIORITY
// dedup fix: a primary use of a resource always wins over an alternate use, so an
// earlier lesson's alternate can never block a later lesson's primary. No DB, no LLM.
// Migrated from scripts/verify-cleanup-lessons.ts (R2).
import { describe, it, expect } from 'vitest';
import { ConceptResourceRole } from '@prisma/client';
import { cleanupLessons, type CleanupLesson } from '@/lib/agents/track/cleanup-lessons';
import type { AllocatorCandidate } from '@/lib/agents/track/allocate';

const cand = (resourceId: string): AllocatorCandidate => ({ resourceId, durationMin: 10 });
const L = (key: string, primaries: string[], alternates: string[] = [], demotedCoreCount = 0): CleanupLesson => ({
  key,
  primaries: primaries.map(cand),
  alternates: alternates.map(cand),
  demotedCoreCount,
});
const ids = (cs: AllocatorCandidate[]) => cs.map((c) => c.resourceId);
// No resource may appear in more than one lesson (primary or alternate).
const noCrossLessonDup = (r: ReturnType<typeof cleanupLessons>) => {
  const seen = new Set<string>();
  for (const l of r.lessons)
    for (const c of [...l.primaries, ...l.alternates]) {
      if (seen.has(c.resourceId)) return false;
      seen.add(c.resourceId);
    }
  return true;
};
const roles = (m: Record<string, ConceptResourceRole>) => new Map(Object.entries(m));

describe('role priority — earlier ALTERNATE must not block a later PRIMARY', () => {
  // L1: primary A, pool alternate R. L2: primary R (its only teacher).
  const r = cleanupLessons({
    lessons: [L('L1', ['A'], ['R']), L('L2', ['R'])],
    roleById: roles({ A: ConceptResourceRole.teaches, R: ConceptResourceRole.teaches }),
  });
  const l1 = r.lessons.find((l) => l.key === 'L1')!;
  const l2 = r.lessons.find((l) => l.key === 'L2')!;

  it('L1 does NOT keep R as an alternate', () => expect(ids(l1.alternates)).not.toContain('R'));
  it('L2 keeps R as its primary', () => expect(ids(l2.primaries)).toContain('R'));
  it('no cross-lesson duplicate', () => expect(noCrossLessonDup(r)).toBe(true));
  it('no warnings', () => expect(r.warnings.length).toBe(0));
});

describe('primary-vs-primary — first lesson keeps it, later promotes a replacement', () => {
  // R is a primary of both L1 and L2; L2 also has alternate-only S.
  const r = cleanupLessons({
    lessons: [L('L1', ['R']), L('L2', ['R'], ['S'])],
    roleById: roles({ R: ConceptResourceRole.teaches, S: ConceptResourceRole.teaches }),
  });
  const l1 = r.lessons.find((l) => l.key === 'L1')!;
  const l2 = r.lessons.find((l) => l.key === 'L2')!;

  it('L1 keeps R (first lesson wins)', () => expect(ids(l1.primaries)).toContain('R'));
  it('L2 promotes S (not the duplicate R)', () => {
    expect(ids(l2.primaries)).toContain('S');
    expect(ids(l2.primaries)).not.toContain('R');
  });
  it('no cross-lesson duplicate', () => expect(noCrossLessonDup(r)).toBe(true));
});

describe('last resort — duplicate-only primary with no replacement warns, keeps dup', () => {
  const r = cleanupLessons({
    lessons: [L('L1', ['R']), L('L2', ['R'])],
    roleById: roles({ R: ConceptResourceRole.teaches }),
  });
  const l2 = r.lessons.find((l) => l.key === 'L2')!;

  it('L2 keeps the duplicate R (never 0-primary)', () => expect(ids(l2.primaries)).toContain('R'));
  it('records a warning', () => expect(r.warnings.length).toBe(1));
});

describe('teaches preference + alternate cap still hold', () => {
  it('promotes the teaches (T) over the uses (U)', () => {
    // L2 core emptied; promote prefers a `teaches` (T) over a `uses` (U); both alt-only.
    const r = cleanupLessons({
      lessons: [L('L1', ['R']), L('L2', ['R'], ['U', 'T'])],
      roleById: roles({ R: ConceptResourceRole.teaches, U: ConceptResourceRole.uses, T: ConceptResourceRole.teaches }),
    });
    const l2 = r.lessons.find((l) => l.key === 'L2')!;
    expect(ids(l2.primaries)[0]).toBe('T');
  });

  it('demoted-core kept; pool capped to #primaries', () => {
    // Pool capped to #primaries (1 here); demoted-core always kept.
    const capped = cleanupLessons({
      lessons: [L('L1', ['P'], ['D', 'X', 'Y'], 1)], // D is demoted-core, X/Y pool
      roleById: roles({
        P: ConceptResourceRole.teaches,
        D: ConceptResourceRole.teaches,
        X: ConceptResourceRole.uses,
        Y: ConceptResourceRole.uses,
      }),
    });
    const l1 = capped.lessons[0];
    expect(ids(l1.alternates)).toContain('D');
    expect(ids(l1.alternates).filter((x) => x === 'X' || x === 'Y').length).toBe(1);
  });
});
