// DB integration test for the chat-intake sessions-per-hour cap. Real DB, NO
// LLM (session rows created directly). Self-cleaning via the __verify_intake__
// marker. Skips cleanly without DATABASE_URL (describeDb).
import { beforeAll, afterAll, it, expect } from 'vitest';
import { IntakeSessionStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  INTAKE_SESSIONS_PER_HOUR,
  INTAKE_SESSION_WINDOW_MS,
  intakeSessionBurst,
} from '@/lib/services/intake-limits';
import { describeDb } from './db';

const MARK = '__verify_intake__';
const USER_ID = `${MARK}user`;
const OTHER_USER_ID = `${MARK}other`;
const NOW = new Date('2026-07-09T12:00:00Z');

async function cleanup() {
  await prisma.intakeSession.deleteMany({ where: { userId: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: MARK } } });
}

function makeSession(over: {
  createdAt: Date;
  userId?: string;
  status?: IntakeSessionStatus;
}) {
  return prisma.intakeSession.create({
    data: {
      userId: over.userId ?? USER_ID,
      status: over.status ?? IntakeSessionStatus.active,
      createdAt: over.createdAt,
    },
    select: { id: true },
  });
}

describeDb('intakeSessionBurst', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.user.createMany({
      data: [
        { id: USER_ID, email: `${MARK}@example.test` },
        { id: OTHER_USER_ID, email: `${MARK}other@example.test` },
      ],
    });
  });
  afterAll(cleanup);

  it('counts all in-window sessions regardless of status, ignoring old rows and other users', async () => {
    const inWindow = new Date(NOW.getTime() - INTAKE_SESSION_WINDOW_MS / 2);
    const outside = new Date(NOW.getTime() - INTAKE_SESSION_WINDOW_MS - 60_000);

    await makeSession({ createdAt: outside }); // must not count
    await makeSession({ createdAt: inWindow, userId: OTHER_USER_ID }); // other user — must not count
    await makeSession({ createdAt: inWindow });
    // Non-active sessions burned LLM calls too — they count.
    await makeSession({ createdAt: inWindow, status: IntakeSessionStatus.exhausted });

    const at2 = await intakeSessionBurst(USER_ID, NOW);
    expect(at2.used).toBe(2);
    expect(at2.limit).toBe(INTAKE_SESSIONS_PER_HOUR);
    expect(at2.allowed).toBe(2 < INTAKE_SESSIONS_PER_HOUR);
  });

  it('blocks at the cap', async () => {
    const inWindow = new Date(NOW.getTime() - INTAKE_SESSION_WINDOW_MS / 2);
    const { used } = await intakeSessionBurst(USER_ID, NOW);
    for (let i = used; i < INTAKE_SESSIONS_PER_HOUR; i++) {
      await makeSession({ createdAt: inWindow });
    }
    const atCap = await intakeSessionBurst(USER_ID, NOW);
    expect(atCap.used).toBe(INTAKE_SESSIONS_PER_HOUR);
    expect(atCap.allowed).toBe(false);
  });
});
