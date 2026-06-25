// Verification for the Lever A attachment-hygiene split (capCandidates vs.
// selectAttachable).
//   npx tsx --env-file=.env.local scripts/verify-attach.ts
//
// Pure fixtures only — no DB, no LLM. Locks in the fix that the MERGED-set cap
// (capCandidates) is count-only and can never empty a concept, while the fresh-
// judge admission filter (selectAttachable) still applies the coverage floor.

import { ConceptResourceRole } from '@prisma/client';
import { capCandidates, selectAttachable } from '../src/lib/agents/map/attach-candidates';
import { MAP_MAX_CANDIDATES_PER_CONCEPT, MAP_ATTACH_MIN_COVERAGE } from '../src/lib/config';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

type Cand = { id: string; role: ConceptResourceRole; coverageScore: number };
const teaches = (id: string, coverageScore: number): Cand => ({ id, role: ConceptResourceRole.teaches, coverageScore });
const uses = (id: string, coverageScore: number): Cand => ({ id, role: ConceptResourceRole.uses, coverageScore });
const ids = (cs: Cand[]) => cs.map((c) => c.id);
const CAP = MAP_MAX_CANDIDATES_PER_CONCEPT;

console.log('selectAttachable — admission filter (floor + cap)');
{
  // Floor drops < MAP_ATTACH_MIN_COVERAGE.
  const out = selectAttachable([uses('a', 0.9), uses('b', MAP_ATTACH_MIN_COVERAGE - 0.05), teaches('c', 0.6)]);
  check('drops below-floor candidate', !ids(out).includes('b'), ids(out));

  // Cap holds at MAP_MAX_CANDIDATES_PER_CONCEPT.
  const many = Array.from({ length: CAP + 4 }, (_, i) => uses(`u${i}`, 0.9 - i * 0.01));
  check('caps to MAX', selectAttachable(many).length === CAP, selectAttachable(many).length);

  // A qualifying teaches survives even when CAP higher-coverage uses crowd it out.
  const crowd = [...Array.from({ length: CAP }, (_, i) => uses(`u${i}`, 1.0)), teaches('t', 0.55)];
  check('retains qualifying teaches under cap', ids(selectAttachable(crowd)).includes('t'), ids(selectAttachable(crowd)));

  // The regression case at admission time: an all-sub-floor set is correctly
  // emptied by the floor (these were never good enough to attach).
  const subFloor = Array.from({ length: CAP + 2 }, (_, i) => uses(`s${i}`, 0.2 + i * 0.005));
  check('floor empties an all-sub-floor FRESH set', selectAttachable(subFloor).length === 0, selectAttachable(subFloor).length);
}

console.log('capCandidates — merged-set bound (count-only, NO floor)');
{
  // THE FIX: the same all-sub-floor set, re-capped over persisted rows, is NOT
  // emptied — capCandidates keeps CAP of them, so a relaxed concept resting on
  // sub-floor candidates can never be wiped (which would regress readiness).
  const subFloor = Array.from({ length: CAP + 2 }, (_, i) => uses(`s${i}`, 0.2 + i * 0.005));
  const capped = capCandidates(subFloor);
  check('does NOT empty an all-sub-floor merged set', capped.length === CAP, capped.length);
  check('never floors (keeps sub-floor rows)', capped.every((c) => c.coverageScore < MAP_ATTACH_MIN_COVERAGE), ids(capped));

  // Keeps the highest-coverage CAP (drops only the lowest-coverage excess).
  const mixed = [uses('hi1', 0.95), uses('hi2', 0.9), teaches('lo', 0.1)];
  check('no-op when at/under cap', capCandidates(mixed).length === 3, capCandidates(mixed).length);

  // Retains the best qualifying teaches even with no floor and a crowd of uses.
  const crowd = [...Array.from({ length: CAP }, (_, i) => uses(`u${i}`, 1.0)), teaches('t', 0.55), uses('x', 0.05)];
  check('retains qualifying teaches under cap (no floor)', ids(capCandidates(crowd)).includes('t'), ids(capCandidates(crowd)));

  // Never empties a non-empty input, for any size.
  check('single candidate survives', capCandidates([uses('only', 0.01)]).length === 1);
  check('empty in → empty out', capCandidates([]).length === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
