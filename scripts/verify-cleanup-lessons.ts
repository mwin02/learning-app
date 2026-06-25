// Verification for the track-build cleanup pass (cleanup-lessons.ts) — focuses on
// the ROLE-PRIORITY dedup fix: a primary use of a resource always wins over an
// alternate use, so an earlier lesson's alternate can never block a later lesson's
// primary.
//   npx tsx --env-file=.env.local scripts/verify-cleanup-lessons.ts
//
// Pure fixtures only — no DB, no LLM.

import { ConceptResourceRole } from '@prisma/client';
import { cleanupLessons, type CleanupLesson } from '../src/lib/agents/track/cleanup-lessons';
import type { AllocatorCandidate } from '../src/lib/agents/track/allocate';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

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
  for (const l of r.lessons) for (const c of [...l.primaries, ...l.alternates]) {
    if (seen.has(c.resourceId)) return false;
    seen.add(c.resourceId);
  }
  return true;
};
const roles = (m: Record<string, ConceptResourceRole>) => new Map(Object.entries(m));

console.log('role priority — earlier ALTERNATE must not block a later PRIMARY');
{
  // L1: primary A, pool alternate R. L2: primary R (its only teacher).
  const r = cleanupLessons({
    lessons: [L('L1', ['A'], ['R']), L('L2', ['R'])],
    roleById: roles({ A: ConceptResourceRole.teaches, R: ConceptResourceRole.teaches }),
  });
  const l1 = r.lessons.find((l) => l.key === 'L1')!;
  const l2 = r.lessons.find((l) => l.key === 'L2')!;
  check('L1 does NOT keep R as an alternate', !ids(l1.alternates).includes('R'), ids(l1.alternates));
  check('L2 keeps R as its primary', ids(l2.primaries).includes('R'), ids(l2.primaries));
  check('no cross-lesson duplicate', noCrossLessonDup(r));
  check('no warnings', r.warnings.length === 0, r.warnings);
}

console.log('primary-vs-primary — first lesson keeps it, later promotes a replacement');
{
  // R is a primary of both L1 and L2; L2 also has alternate-only S.
  const r = cleanupLessons({
    lessons: [L('L1', ['R']), L('L2', ['R'], ['S'])],
    roleById: roles({ R: ConceptResourceRole.teaches, S: ConceptResourceRole.teaches }),
  });
  const l1 = r.lessons.find((l) => l.key === 'L1')!;
  const l2 = r.lessons.find((l) => l.key === 'L2')!;
  check('L1 keeps R (first lesson wins)', ids(l1.primaries).includes('R'));
  check('L2 promotes S (not the duplicate R)', ids(l2.primaries).includes('S') && !ids(l2.primaries).includes('R'), ids(l2.primaries));
  check('no cross-lesson duplicate', noCrossLessonDup(r));
}

console.log('last resort — duplicate-only primary with no replacement warns, keeps dup');
{
  const r = cleanupLessons({
    lessons: [L('L1', ['R']), L('L2', ['R'])],
    roleById: roles({ R: ConceptResourceRole.teaches }),
  });
  const l2 = r.lessons.find((l) => l.key === 'L2')!;
  check('L2 keeps the duplicate R (never 0-primary)', ids(l2.primaries).includes('R'));
  check('records a warning', r.warnings.length === 1, r.warnings);
}

console.log('teaches preference + alternate cap still hold');
{
  // L2 core emptied; promote prefers a `teaches` (T) over a `uses` (U); both alt-only.
  const r = cleanupLessons({
    lessons: [L('L1', ['R']), L('L2', ['R'], ['U', 'T'])],
    roleById: roles({ R: ConceptResourceRole.teaches, U: ConceptResourceRole.uses, T: ConceptResourceRole.teaches }),
  });
  const l2 = r.lessons.find((l) => l.key === 'L2')!;
  check('promotes the teaches (T) over the uses (U)', ids(l2.primaries) [0] === 'T', ids(l2.primaries));

  // Pool capped to #primaries (1 here); demoted-core always kept.
  const capped = cleanupLessons({
    lessons: [L('L1', ['P'], ['D', 'X', 'Y'], 1)], // D is demoted-core, X/Y pool
    roleById: roles({ P: ConceptResourceRole.teaches, D: ConceptResourceRole.teaches, X: ConceptResourceRole.uses, Y: ConceptResourceRole.uses }),
  });
  const l1 = capped.lessons[0];
  check('demoted-core D kept', ids(l1.alternates).includes('D'), ids(l1.alternates));
  check('pool capped to #primaries (1)', ids(l1.alternates).filter((x) => x === 'X' || x === 'Y').length === 1, ids(l1.alternates));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
