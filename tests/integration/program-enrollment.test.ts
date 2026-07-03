// DB integration tests for Phase 3c (creator auto-enroll + monthly creation
// quota + plan title persistence). Real DB, NO LLM (plan stubbed). Self-cleaning
// via the __verify_enr__ marker. Skips cleanly without DATABASE_URL (describeDb).
//
// NOTE: requires the 3a migration on the target DB (User.email, EnrolledProgram)
// — fails on a pre-3a shared dev DB until `prisma migrate deploy` runs there.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { ProgramStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { enqueueProgram } from '@/lib/services/program';
import { programQuota } from '@/lib/services/program-limits';
import { FREE_PROGRAMS_PER_MONTH } from '@/lib/config';
import type { ProgramPlan } from '@/lib/agents/program/plan';
import { describeDb } from './db';

const MARK = '__verify_enr__';
const USER_ID = `${MARK}user`;

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } }); // cascades EnrolledProgram
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

const stubPlan =
  (over: Partial<ProgramPlan> = {}): (() => Promise<ProgramPlan>) =>
  async () => ({
    topics: [
      {
        key: `${MARK}topic`,
        hoursPerWeek: 2,
        timeframeWeeks: 8,
        phaseLabel: 'Phase 1',
        orderInProgram: 1,
        priorityTier: 'core' as const,
        weight: 1,
        rationale: 'why',
      },
    ],
    droppedByGate: [],
    droppedByBudget: [],
    title: 'Verify Program',
    description: 'A verification program.',
    ...over,
  });

describeDb('program enrollment + creation quota (3c)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER_ID, email: `${MARK}@example.test` } });
  });
  afterAll(cleanup);

  it('auto-enrolls the creator at enqueue and persists the plan title/description', async () => {
    const enq = await enqueueProgram(
      { goal: `${MARK} goal-1`, totalHoursPerWeek: 4, totalWeeks: 8, userId: USER_ID },
      { plan: stubPlan() },
    );
    expect(enq.status).toBe(ProgramStatus.building);

    const enrollment = await prisma.enrolledProgram.findUnique({
      where: { userId_programId: { userId: USER_ID, programId: enq.programId } },
    });
    expect(enrollment).not.toBeNull();

    const program = await prisma.program.findUniqueOrThrow({
      where: { id: enq.programId },
      select: { title: true, description: true },
    });
    expect(program.title).toBe('Verify Program');
    expect(program.description).toBe('A verification program.');
  });

  it('quota counts non-failed programs this month and excludes failed ones', async () => {
    const before = await programQuota(USER_ID);
    expect(before.limit).toBe(FREE_PROGRAMS_PER_MONTH);
    const usedBefore = before.used; // ≥1 from the test above

    // A failed plan (no topics) must not consume quota.
    await enqueueProgram(
      { goal: `${MARK} goal-fail`, totalHoursPerWeek: 4, totalWeeks: 8, userId: USER_ID },
      { plan: stubPlan({ topics: [] }) },
    );
    const afterFailed = await programQuota(USER_ID);
    expect(afterFailed.used).toBe(usedBefore);

    // Another successful creation does.
    await enqueueProgram(
      { goal: `${MARK} goal-2`, totalHoursPerWeek: 4, totalWeeks: 8, userId: USER_ID },
      { plan: stubPlan() },
    );
    const afterSecond = await programQuota(USER_ID);
    expect(afterSecond.used).toBe(usedBefore + 1);
    expect(afterSecond.allowed).toBe(afterSecond.used < afterSecond.limit);
  });

  it('an anonymous (null userId) enqueue creates no enrollment', async () => {
    const enq = await enqueueProgram(
      { goal: `${MARK} goal-anon`, totalHoursPerWeek: 4, totalWeeks: 8 },
      { plan: stubPlan() },
    );
    const count = await prisma.enrolledProgram.count({ where: { programId: enq.programId } });
    expect(count).toBe(0);
  });
});
