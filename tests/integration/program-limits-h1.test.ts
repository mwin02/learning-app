// DB integration tests for H1 (creation-route hardening: burst cap + idempotent
// submit). Real DB, NO LLM (rows created directly / plan stubbed). Self-cleaning
// via the __verify_h1__ marker. Skips cleanly without DATABASE_URL (describeDb).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { ProgramStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { enqueueProgram } from '@/lib/services/program';
import { programBurst, findRecentDuplicate } from '@/lib/services/program-limits';
import { PROGRAM_BURST_PER_HOUR, PROGRAM_BURST_WINDOW_MS, PROGRAM_DEDUP_WINDOW_MS } from '@/lib/config';
import { describeDb } from './db';

const MARK = '__verify_h1__';
const USER_ID = `${MARK}user`;
const NOW = new Date('2026-07-08T12:00:00Z');

async function cleanup() {
  await prisma.program.deleteMany({ where: { goal: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

// A bare Program row with a controlled createdAt — metering reads only
// userId/status/createdAt/inputHash, so the rest is minimal filler.
function makeProgram(over: { createdAt: Date; status?: ProgramStatus; inputHash?: string }) {
  return prisma.program.create({
    data: {
      goal: `${MARK}goal`,
      totalHoursPerWeek: 2,
      totalWeeks: 4,
      status: over.status ?? ProgramStatus.building,
      userId: USER_ID,
      inputHash: over.inputHash ?? null,
      createdAt: over.createdAt,
    },
    select: { id: true },
  });
}

describeDb('H1 burst cap + idempotent submit', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER_ID, email: `${MARK}@example.test` } });
  });
  afterAll(cleanup);

  it('programBurst counts ALL recent statuses (incl. failed) and ignores rows outside the window', async () => {
    const inWindow = new Date(NOW.getTime() - PROGRAM_BURST_WINDOW_MS / 2);
    const outside = new Date(NOW.getTime() - PROGRAM_BURST_WINDOW_MS - 60_000);
    await makeProgram({ createdAt: outside }); // must not count
    await makeProgram({ createdAt: inWindow });
    await makeProgram({ createdAt: inWindow, status: ProgramStatus.failed }); // failed DOES count

    const at2 = await programBurst(USER_ID, NOW);
    expect(at2.used).toBe(2);
    expect(at2.limit).toBe(PROGRAM_BURST_PER_HOUR);
    expect(at2.allowed).toBe(2 < PROGRAM_BURST_PER_HOUR);

    // Fill up to the cap → blocked.
    for (let i = at2.used; i < PROGRAM_BURST_PER_HOUR; i++) {
      await makeProgram({ createdAt: inWindow });
    }
    const atCap = await programBurst(USER_ID, NOW);
    expect(atCap.used).toBe(PROGRAM_BURST_PER_HOUR);
    expect(atCap.allowed).toBe(false);

    await prisma.program.deleteMany({ where: { goal: `${MARK}goal` } });
  });

  it('findRecentDuplicate matches a non-failed same-hash row inside the window only', async () => {
    const hash = `${MARK}hash`;
    const inWindow = new Date(NOW.getTime() - PROGRAM_DEDUP_WINDOW_MS / 2);
    const outside = new Date(NOW.getTime() - PROGRAM_DEDUP_WINDOW_MS - 60_000);

    // Failed same-hash row: never a duplicate (retry after failure is legitimate).
    await makeProgram({ createdAt: inWindow, inputHash: hash, status: ProgramStatus.failed });
    expect(await findRecentDuplicate(USER_ID, hash, NOW)).toBeNull();

    // Same hash but outside the window: not a duplicate.
    const stale = await makeProgram({ createdAt: outside, inputHash: hash });
    expect(await findRecentDuplicate(USER_ID, hash, NOW)).toBeNull();

    // Non-failed, in-window, same hash: THE duplicate.
    const live = await makeProgram({ createdAt: inWindow, inputHash: hash });
    const dup = await findRecentDuplicate(USER_ID, hash, NOW);
    expect(dup?.id).toBe(live.id);
    expect(dup?.id).not.toBe(stale.id);

    // A different hash finds nothing.
    expect(await findRecentDuplicate(USER_ID, `${MARK}other`, NOW)).toBeNull();

    await prisma.program.deleteMany({ where: { goal: `${MARK}goal` } });
  });

  it('enqueueProgram persists inputHash on the anchor row', async () => {
    const hash = `${MARK}persisted`;
    const result = await enqueueProgram(
      {
        goal: `${MARK}goal enqueue`,
        totalHoursPerWeek: 2,
        totalWeeks: 4,
        userId: USER_ID,
        inputHash: hash,
      },
      {
        plan: async () => ({
          topics: [],
          droppedByGate: [],
          droppedByBudget: [],
        }),
      },
    );
    const row = await prisma.program.findUniqueOrThrow({
      where: { id: result.programId },
      select: { inputHash: true },
    });
    expect(row.inputHash).toBe(hash);
  });
});
