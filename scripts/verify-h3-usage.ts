// Throwaway H3 driver: verifies planUsage / buildUsage persistence end-to-end
// with a stubbed plan (no LLM). Run against the LOCAL docker DB (it has the H3
// migration; prod gets it at deploy):
//   DATABASE_URL="postgresql://postgres:postgres@localhost:55432/learning_app" \
//     npx tsx --env-file=.env.local scripts/verify-h3-usage.ts
// Self-cleaning via the __verify_h3__ marker.

import { PriorityTier } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordUsage, runWithTrace } from '@/lib/log';
import { enqueueProgram } from '@/lib/services/program';
import { finishCourseRequest } from '@/lib/services/course-request';

const MARK = '__verify_h3__';

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } });
  await prisma.courseRequest.deleteMany({ where: { topic: { startsWith: MARK } } });
}

async function main() {
  await cleanup();

  // --- planUsage via enqueueProgram inside a trace -------------------------
  const result = await runWithTrace('verify-h3-trace', async () => {
    return enqueueProgram(
      { goal: `${MARK} learn calculus`, totalHoursPerWeek: 5, totalWeeks: 8 },
      {
        plan: async () => {
          recordUsage('plan.decompose', { inputTokens: 100, outputTokens: 40, totalTokens: 140 });
          recordUsage('plan.gate', { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
          return {
            topics: [
              {
                key: `${MARK}calculus`,
                weight: 1,
                priorityTier: PriorityTier.core,
                phaseLabel: 'Phase 1',
                orderHint: 1,
                rationale: 'verify',
                frontierConcepts: [],
                hoursPerWeek: 5,
                timeframeWeeks: 8,
                orderInProgram: 1,
              },
            ],
            droppedByGate: [],
            droppedByBudget: [],
            title: 'verify',
            description: 'verify',
          };
        },
      },
    );
  });
  const program = await prisma.program.findUniqueOrThrow({
    where: { id: result.programId },
    select: { planUsage: true, status: true },
  });
  console.log('planUsage persisted:', JSON.stringify(program.planUsage));

  // --- buildUsage via finishCourseRequest ----------------------------------
  const cr = await prisma.courseRequest.findFirstOrThrow({
    where: { topic: `${MARK}calculus` },
    select: { id: true },
  });
  await prisma.courseRequest.update({ where: { id: cr.id }, data: { status: 'running' } });
  await runWithTrace(cr.id, async () => {
    recordUsage('track.composer', { inputTokens: 500, outputTokens: 200, totalTokens: 700 });
    const { traceUsageSnapshot } = await import('@/lib/log');
    await finishCourseRequest(cr.id, {
      status: 'failed',
      error: 'verify-h3 synthetic failure',
      buildUsage: traceUsageSnapshot(),
    });
  });
  const finished = await prisma.courseRequest.findUniqueOrThrow({
    where: { id: cr.id },
    select: { buildUsage: true, status: true },
  });
  console.log('buildUsage persisted:', JSON.stringify(finished.buildUsage));

  await cleanup();
  console.log('cleaned up.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
