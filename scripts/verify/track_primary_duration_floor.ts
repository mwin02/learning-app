// Verify: the deterministic primary duration-floor pass (build-track
// `enforcePrimaryDurationFloor` + TRACK_MIN_PRIMARY_DURATION_MIN).
//
//   Part A — pure-function fixtures (no DB): swap fires only when it should.
//   Part B — end-to-end: rebuild the python demo Path a few times and assert the
//            "operators-and-expressions" lesson never leads with the ~1-min Short.
//
// Run: npx tsx --env-file=.env.local scripts/verify/track_primary_duration_floor.ts

import { ConceptResourceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildTrack, enforcePrimaryDurationFloor } from '@/lib/agents/track/build-track';
import { TRACK_MIN_PRIMARY_DURATION_MIN as FLOOR } from '@/lib/config';
import type { ValidatedLesson } from '@/lib/agents/track/validate-composition';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// --- fixture scaffolding ---------------------------------------------------
const SHORT = 'r-short'; // 1 min, teaches  (a Short)
const LONG = 'r-long'; //  11 min, teaches  (the real teacher)
const LONG2 = 'r-long2'; // 15 min, teaches
const USES = 'r-uses'; //  20 min, uses    (long but not a teacher)
const GEN = 'r-gen'; //    1 min, teaches  (authored on-ramp)

const dur: Record<string, number> = {
  [SHORT]: 1,
  [LONG]: 11,
  [LONG2]: 15,
  [USES]: 20,
  [GEN]: 1,
};
const role: Record<string, ConceptResourceRole> = {
  [SHORT]: ConceptResourceRole.teaches,
  [LONG]: ConceptResourceRole.teaches,
  [LONG2]: ConceptResourceRole.teaches,
  [USES]: ConceptResourceRole.uses,
  [GEN]: ConceptResourceRole.teaches,
};

function lesson(mandatory: string[], optional: string[]): ValidatedLesson {
  return {
    conceptSlugs: ['c'],
    timeWeight: 'normal',
    mandatoryResourceIds: mandatory,
    optionalResourceIds: optional,
    title: 't',
    summary: 's',
    isFrontier: false,
    masteryRelevant: true,
  };
}

function run(lessons: ValidatedLesson[], generated: string[] = []) {
  return enforcePrimaryDurationFloor(lessons, {
    durOf: (id) => dur[id] ?? 0,
    roleOf: (id) => role[id],
    generatedIds: new Set(generated),
    floorMin: FLOOR,
  });
}

function partA() {
  console.log(`\n--- Part A: pure fixtures (floor=${FLOOR}min) ---`);

  // 1. Thin lead + longer teaches in optional → swapped; thin demoted to optional[0].
  {
    const [out] = run([lesson([SHORT], [LONG])]);
    check('1 swap: thin lead replaced by longer teaches', out.mandatoryResourceIds[0] === LONG);
    check('1 swap: thin demoted to optional front', out.optionalResourceIds[0] === SHORT);
    check('1 swap: replacement removed from optional', !out.optionalResourceIds.includes(LONG));
  }

  // 2. Thin lead, only thin candidates → unchanged (≥1 guarantee).
  {
    const [out] = run([lesson([SHORT], [])]);
    check('2 no-op: thin-only concept keeps its clip', out.mandatoryResourceIds[0] === SHORT);
  }

  // 3. Thin lead but generated on-ramp → exempt, unchanged.
  {
    const [out] = run([lesson([GEN], [LONG])], [GEN]);
    check('3 exempt: generated on-ramp keeps lead', out.mandatoryResourceIds[0] === GEN);
  }

  // 4. Thin lead, only a long non-teaches replacement → unchanged.
  {
    const [out] = run([lesson([SHORT], [USES])]);
    check('4 no-op: long `uses` is not a valid teacher replacement', out.mandatoryResourceIds[0] === SHORT);
  }

  // 5. Healthy lead (>= floor) → untouched.
  {
    const [out] = run([lesson([LONG], [SHORT])]);
    check('5 no-op: healthy lead left as-is', out.mandatoryResourceIds[0] === LONG);
    check('5 no-op: pool untouched', out.optionalResourceIds[0] === SHORT);
  }

  // 6. Qualifying teacher in the mandatory TAIL → promoted from tail; thin demoted.
  {
    const [out] = run([lesson([SHORT, LONG2], [LONG])]);
    check('6 tail: mandatory-tail teacher promoted to lead', out.mandatoryResourceIds[0] === LONG2);
    check('6 tail: old thin lead demoted to optional', out.optionalResourceIds[0] === SHORT);
    check('6 tail: promoted id no longer in mandatory tail', !out.mandatoryResourceIds.slice(1).includes(LONG2));
  }
}

// --- Part B: end-to-end on the python demo Path ----------------------------
const PATH_ID = 'cmqxtruaq002o3em5pgd4u45n';
const SHORT_ID = 'cmqwlgn69002m6fm5w3vatm8h'; // the ~1-min Short
const E2E_RUNS = 3;

async function partB() {
  console.log(`\n--- Part B: ${E2E_RUNS}x end-to-end build of python demo Path ---`);
  const path = await prisma.path.findUnique({ where: { id: PATH_ID }, select: { status: true } });
  if (path?.status !== 'spine_ready') {
    console.log(`SKIP  Part B: Path ${PATH_ID} is '${path?.status ?? 'missing'}', not spine_ready`);
    return;
  }
  const created: string[] = [];
  try {
    for (let i = 0; i < E2E_RUNS; i++) {
      const { trackId } = await buildTrack({ pathId: PATH_ID, goal: 'verify floor', targetMastery: 'beginner' });
      created.push(trackId);
      const ops = (
        await prisma.lesson.findMany({
          where: { trackId },
          select: { id: true, conceptsTaught: true },
        })
      ).find((l) => l.conceptsTaught.includes('operators-and-expressions'));
      if (!ops) {
        check(`B run ${i + 1}: operators lesson exists`, false);
        continue;
      }
      const prim = await prisma.lessonResource.findFirst({
        where: { lessonId: ops.id, role: 'primary' },
        orderBy: { orderInLesson: 'asc' },
        select: { resource: { select: { id: true, durationMin: true, title: true } } },
      });
      const ok = !!prim && prim.resource.id !== SHORT_ID && prim.resource.durationMin >= FLOOR;
      check(
        `B run ${i + 1}: primary is non-thin (${prim?.resource.durationMin}min "${prim?.resource.title}")`,
        ok,
      );
    }
  } finally {
    for (const id of created) await prisma.track.delete({ where: { id } }).catch(() => {});
    console.log(`cleaned up ${created.length} throwaway track(s)`);
  }
}

async function main() {
  partA();
  await partB();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
