// Unit tests for the deterministic build-track passes enforceGeneratedPrimary (Phase
// 2g-5) and enforcePrimaryDurationFloor (the primary duration-floor pass). No DB, no
// LLM. Migrated from scripts/verify-onramp-primary.ts and Part A of
// scripts/verify/track_primary_duration_floor.ts (R2).
import { describe, it, expect, vi } from 'vitest';
import { ConceptResourceRole } from '@prisma/client';

// build-track.ts pulls in @/lib/db and (via tools/web-fallback) @/lib/ai/vertex, both
// of which throw at module-eval without their env vars. web-fallback imports `vertex`
// directly, so we stub the vertex LEAF (not just @/lib/ai/models). The two passes under
// test are pure and touch neither, so this keeps the file in the unit project.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  geminiFlash: {},
  vertexAnthropic: {},
  vertexGlobal: {},
}));

import { enforceGeneratedPrimary, enforcePrimaryDurationFloor } from '@/lib/agents/track/build-track';
import { TRACK_MIN_PRIMARY_DURATION_MIN as FLOOR } from '@/lib/config';
import type { ValidatedLesson } from '@/lib/agents/track/validate-composition';

describe('enforceGeneratedPrimary — the generated on-ramp lesson leads its lesson', () => {
  const lesson = (over: Partial<ValidatedLesson>): ValidatedLesson => ({
    conceptSlugs: ['c'],
    timeWeight: 'standard' as ValidatedLesson['timeWeight'],
    mandatoryResourceIds: [],
    optionalResourceIds: [],
    title: 't',
    summary: 's',
    isFrontier: false,
    masteryRelevant: false,
    ...over,
  });

  it('generated in the OPTIONAL pool → promoted to mandatory[0]', () => {
    const [out] = enforceGeneratedPrimary(
      [lesson({ mandatoryResourceIds: ['sourced'], optionalResourceIds: ['gen', 'other'] })],
      new Set(['gen']),
    );
    expect(out.mandatoryResourceIds[0]).toBe('gen');
    expect(out.mandatoryResourceIds).toContain('sourced'); // prior mandatory preserved after it
    expect(out.optionalResourceIds).not.toContain('gen'); // removed from optional
    expect(out.optionalResourceIds).toContain('other'); // other optional kept
  });

  it('generated already mandatory but NOT first → moved to front, no duplication', () => {
    const [out] = enforceGeneratedPrimary([lesson({ mandatoryResourceIds: ['sourced', 'gen'] })], new Set(['gen']));
    expect(out.mandatoryResourceIds[0]).toBe('gen');
    expect(out.mandatoryResourceIds.filter((i) => i === 'gen').length).toBe(1);
  });

  it('generated already leading → unchanged (returns the same lesson object)', () => {
    const input = [lesson({ mandatoryResourceIds: ['gen', 'sourced'] })];
    const out = enforceGeneratedPrimary(input, new Set(['gen']));
    expect(out[0]).toBe(input[0]);
  });

  it('merged on-ramp + X lesson: X stays a secondary primary', () => {
    const [out] = enforceGeneratedPrimary(
      [lesson({ conceptSlugs: ['on-ramp', 'jsx'], mandatoryResourceIds: ['jsx-res'], optionalResourceIds: ['gen'] })],
      new Set(['gen']),
    );
    expect(out.mandatoryResourceIds).toEqual(['gen', 'jsx-res']);
  });

  it('no generated candidate / empty set → untouched', () => {
    const input = [lesson({ mandatoryResourceIds: ['a'], optionalResourceIds: ['b'] })];
    expect(enforceGeneratedPrimary(input, new Set(['gen']))[0]).toBe(input[0]);
    expect(enforceGeneratedPrimary(input, new Set())).toBe(input); // returns input as-is
  });
});

describe(`enforcePrimaryDurationFloor — swap a thin lead for a real teacher (floor=${FLOOR}min)`, () => {
  const SHORT = 'r-short'; // 1 min, teaches  (a Short)
  const LONG = 'r-long'; //  11 min, teaches  (the real teacher)
  const LONG2 = 'r-long2'; // 15 min, teaches
  const USES = 'r-uses'; //  20 min, uses    (long but not a teacher)
  const GEN = 'r-gen'; //    1 min, teaches  (authored on-ramp)

  const dur: Record<string, number> = { [SHORT]: 1, [LONG]: 11, [LONG2]: 15, [USES]: 20, [GEN]: 1 };
  const role: Record<string, ConceptResourceRole> = {
    [SHORT]: ConceptResourceRole.teaches,
    [LONG]: ConceptResourceRole.teaches,
    [LONG2]: ConceptResourceRole.teaches,
    [USES]: ConceptResourceRole.uses,
    [GEN]: ConceptResourceRole.teaches,
  };
  const lesson = (mandatory: string[], optional: string[]): ValidatedLesson => ({
    conceptSlugs: ['c'],
    timeWeight: 'normal',
    mandatoryResourceIds: mandatory,
    optionalResourceIds: optional,
    title: 't',
    summary: 's',
    isFrontier: false,
    masteryRelevant: true,
  });
  const run = (lessons: ValidatedLesson[], generated: string[] = []) =>
    enforcePrimaryDurationFloor(lessons, {
      durOf: (id) => dur[id] ?? 0,
      roleOf: (id) => role[id],
      generatedIds: new Set(generated),
      floorMin: FLOOR,
    });

  it('thin lead + longer teaches in optional → swapped; thin demoted to optional front', () => {
    const [out] = run([lesson([SHORT], [LONG])]);
    expect(out.mandatoryResourceIds[0]).toBe(LONG);
    expect(out.optionalResourceIds[0]).toBe(SHORT);
    expect(out.optionalResourceIds).not.toContain(LONG); // replacement removed from optional
  });

  it('thin lead, only thin candidates → unchanged (≥1 guarantee)', () => {
    const [out] = run([lesson([SHORT], [])]);
    expect(out.mandatoryResourceIds[0]).toBe(SHORT);
  });

  it('thin lead but generated on-ramp → exempt, unchanged', () => {
    const [out] = run([lesson([GEN], [LONG])], [GEN]);
    expect(out.mandatoryResourceIds[0]).toBe(GEN);
  });

  it('thin lead, only a long non-teaches replacement → unchanged', () => {
    const [out] = run([lesson([SHORT], [USES])]);
    expect(out.mandatoryResourceIds[0]).toBe(SHORT);
  });

  it('healthy lead (>= floor) → untouched, pool untouched', () => {
    const [out] = run([lesson([LONG], [SHORT])]);
    expect(out.mandatoryResourceIds[0]).toBe(LONG);
    expect(out.optionalResourceIds[0]).toBe(SHORT);
  });

  it('qualifying teacher in the mandatory TAIL → promoted from tail; thin demoted', () => {
    const [out] = run([lesson([SHORT, LONG2], [LONG])]);
    expect(out.mandatoryResourceIds[0]).toBe(LONG2);
    expect(out.optionalResourceIds[0]).toBe(SHORT);
    expect(out.mandatoryResourceIds.slice(1)).not.toContain(LONG2); // no longer in mandatory tail
  });
});
