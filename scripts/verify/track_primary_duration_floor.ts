// Verify (LIVE half): the deterministic primary duration-floor pass, end-to-end —
// rebuild the python demo Path a few times and assert the "operators-and-expressions"
// lesson never leads with the ~1-min Short. Costs Pro compose calls; self-cleans.
//
// The pure Part A (enforcePrimaryDurationFloor fixtures: swap fires only when it should)
// migrated to src/lib/agents/track/build-track.test.ts (R2). Run:
//   npx tsx --env-file=.env.local scripts/verify/track_primary_duration_floor.ts

import { prisma } from '@/lib/db';
import { buildTrack } from '@/lib/agents/track/build-track';
import { TRACK_MIN_PRIMARY_DURATION_MIN as FLOOR } from '@/lib/config';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// --- Part B: end-to-end on the python demo Path ----------------------------
const PATH_ID = 'cmqxtruaq002o3em5pgd4u45n';
const SHORT_ID = 'cmqwlgn69002m6fm5w3vatm8h'; // the ~1-min Short
const E2E_RUNS = 3;

async function partB() {
  console.log(`\n--- Part B: ${E2E_RUNS}x end-to-end build of python demo Path (floor=${FLOOR}min) ---`);
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
  await partB();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
