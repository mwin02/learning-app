// DB integration verification for Phase 2.75c (fan-out + assembler).
//   npx tsx --env-file=.env.local scripts/verify-program-fanout.ts
//
// Real DB, NO LLM (enqueueProgram's plan is stubbed). Self-cleaning: throwaway rows
// are marked with __verify_prog__ and deleted first. Asserts:
//   - enqueueProgram fans a plan out to Program(building) + N ProgramPath (trackId
//     null) + N child CourseRequest(queued, programId, per-topic budget).
//   - maybeAssembleProgram is a no-op while a sibling is non-terminal.
//   - all-fulfilled → ready (+ trackId linked); mixed → partial; all-failed → failed.
//   - the finalize is idempotent (second call is a no-op).

import { ProgramStatus, CourseRequestStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { enqueueProgram, maybeAssembleProgram } from '../src/lib/services/program';
import type { ProgramPlan } from '../src/lib/agents/program/plan';

const MARK = '__verify_prog__';
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } }); // cascades ProgramPath + CourseRequest
  await prisma.track.deleteMany({ where: { path: { topic: { startsWith: MARK } } } });
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

// Build a stub plan for the given canonical topic keys.
const stubPlan =
  (keys: string[]): ((i: unknown) => Promise<ProgramPlan>) =>
  async () => ({
    topics: keys.map((key, i) => ({
      key,
      hoursPerWeek: 2,
      timeframeWeeks: 8,
      phaseLabel: `Phase ${i + 1}`,
      orderInProgram: i + 1,
      priorityTier: i === 0 ? ('core' as const) : ('nice_to_have' as const),
      weight: 1,
      rationale: `why ${key}`,
    })),
    droppedByGate: [],
    droppedByBudget: [],
  });

// A throwaway built Track (needs a Path) to stand in for a fulfilled child.
async function makeTrack(topic: string): Promise<string> {
  const path = await prisma.path.create({ data: { topic: `${MARK}${topic}` }, select: { id: true } });
  const track = await prisma.track.create({
    data: { pathId: path.id, status: 'ready', title: `Track for ${topic}` },
    select: { id: true },
  });
  return track.id;
}

async function siblings(programId: string) {
  return prisma.courseRequest.findMany({ where: { programId }, orderBy: { topic: 'asc' } });
}
async function programStatus(programId: string) {
  return (await prisma.program.findUniqueOrThrow({ where: { id: programId }, select: { status: true } })).status;
}

async function main() {
  await cleanup();

  const kA = `${MARK}alpha`;
  const kB = `${MARK}beta`;

  console.log('enqueueProgram — fans a plan out to building + slots + child requests');
  const enq = await enqueueProgram(
    { goal: `${MARK} goal`, background: 'bg', totalHoursPerWeek: 4, totalWeeks: 8 },
    { plan: stubPlan([kA, kB]) },
  );
  check('returns building', enq.status === ProgramStatus.building && enq.topicCount === 2, enq);
  check('program is building', (await programStatus(enq.programId)) === ProgramStatus.building);
  const paths = await prisma.programPath.findMany({ where: { programId: enq.programId }, orderBy: { orderInProgram: 'asc' } });
  check('2 program paths, trackId null', paths.length === 2 && paths.every((p) => p.trackId === null), paths);
  const reqs = await siblings(enq.programId);
  check('2 child requests queued w/ programId + budget', reqs.length === 2 && reqs.every((r) => r.status === 'queued' && r.programId === enq.programId && r.hoursPerWeek === 2 && r.timeframeWeeks === 8), reqs);
  check('child goal = per-topic rationale', reqs[0].goal === `why ${reqs[0].topic}`);

  console.log('maybeAssembleProgram — no-op while a sibling is non-terminal');
  await maybeAssembleProgram(enq.programId);
  check('still building (nothing terminal)', (await programStatus(enq.programId)) === ProgramStatus.building);

  console.log('assemble — mixed (one fulfilled, one failed) → partial + trackId linked');
  const trackA = await makeTrack('alpha');
  // Directly drive terminal states (simulating the worker's finish), bypassing the
  // claim state machine — the assembler only reads status/topic/trackId.
  await prisma.courseRequest.update({ where: { id: reqs[0].id }, data: { status: CourseRequestStatus.fulfilled, trackId: trackA } });
  await prisma.courseRequest.update({ where: { id: reqs[1].id }, data: { status: CourseRequestStatus.failed, error: 'boom' } });
  await maybeAssembleProgram(enq.programId);
  check('program partial', (await programStatus(enq.programId)) === ProgramStatus.partial);
  const slotA = await prisma.programPath.findFirstOrThrow({ where: { programId: enq.programId, topic: reqs[0].topic } });
  const slotB = await prisma.programPath.findFirstOrThrow({ where: { programId: enq.programId, topic: reqs[1].topic } });
  check('fulfilled slot linked to track', slotA.trackId === trackA, slotA);
  check('failed slot stays null', slotB.trackId === null, slotB);

  console.log('assemble — idempotent (second call is a no-op)');
  await maybeAssembleProgram(enq.programId);
  check('still partial', (await programStatus(enq.programId)) === ProgramStatus.partial);

  console.log('assemble — all fulfilled → ready');
  const enq2 = await enqueueProgram({ goal: `${MARK} goal2`, totalHoursPerWeek: 4, totalWeeks: 8 }, { plan: stubPlan([kA, kB]) });
  const reqs2 = await siblings(enq2.programId);
  const tA = await makeTrack('alpha2');
  const tB = await makeTrack('beta2');
  await prisma.courseRequest.update({ where: { id: reqs2[0].id }, data: { status: CourseRequestStatus.fulfilled, trackId: tA } });
  await prisma.courseRequest.update({ where: { id: reqs2[1].id }, data: { status: CourseRequestStatus.fulfilled, trackId: tB } });
  await maybeAssembleProgram(enq2.programId);
  check('program ready', (await programStatus(enq2.programId)) === ProgramStatus.ready);

  console.log('assemble — all failed → failed');
  const enq3 = await enqueueProgram({ goal: `${MARK} goal3`, totalHoursPerWeek: 4, totalWeeks: 8 }, { plan: stubPlan([kA, kB]) });
  await prisma.courseRequest.updateMany({ where: { programId: enq3.programId }, data: { status: CourseRequestStatus.failed, error: 'x' } });
  await maybeAssembleProgram(enq3.programId);
  check('program failed', (await programStatus(enq3.programId)) === ProgramStatus.failed);

  console.log('enqueueProgram — empty plan → failed with error, no requests');
  const enq4 = await enqueueProgram({ goal: `${MARK} goal4`, totalHoursPerWeek: 4, totalWeeks: 8 }, {
    plan: async () => ({ topics: [], droppedByGate: [{ topic: 'cooking', reason: 'out of domain' }], droppedByBudget: [] }),
  });
  check('returns failed, 0 topics', enq4.status === ProgramStatus.failed && enq4.topicCount === 0, enq4);
  const prog4 = await prisma.program.findUniqueOrThrow({ where: { id: enq4.programId }, select: { status: true, error: true } });
  check('failed w/ error, no child requests', prog4.status === ProgramStatus.failed && !!prog4.error && (await siblings(enq4.programId)).length === 0, prog4);

  await cleanup();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
