// Chat intake (Block 1): the intake agent's own LLM rate limits, beside the
// program creation limits (program-limits.ts). Every chat turn is an LLM call,
// so spend is bounded per user per hour by INTAKE_SESSIONS_PER_HOUR ×
// INTAKE_MAX_TURNS — worst case 75 Flash calls/hour at the defaults. Routes ask
// these functions and compare; nothing else decides intake limits.

import { prisma } from '@/lib/db';

// Pure + exported for the colocated unit test: an env override must be a
// positive integer or it's ignored (a typo'd override silently disabling a
// rate limit — 0, NaN, negative — is worse than the default).
export function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Env-overridable (unlike the program limit constants in config.ts, which are
// code-reviewed knobs): intake limits are launch-window dials we may need to
// turn on a live deployment without a redeploy, same motive as MODEL_<AGENT>.
export const INTAKE_SESSIONS_PER_HOUR = parsePositiveIntEnv(
  process.env.INTAKE_SESSIONS_PER_HOUR,
  5,
);
export const INTAKE_MAX_TURNS = parsePositiveIntEnv(process.env.INTAKE_MAX_TURNS, 15);
export const INTAKE_SESSION_WINDOW_MS = parsePositiveIntEnv(
  process.env.INTAKE_SESSION_WINDOW_MS,
  60 * 60 * 1000,
);

export type IntakeLimit = {
  allowed: boolean;
  used: number;
  limit: number;
};

// The sessions-per-hour cap, checked on session CREATE only (an existing
// session's turns are the turn budget's job). Counts ALL statuses — an
// exhausted or abandoned session burned LLM calls all the same. Same DB-counting
// idiom and soft-limit race caveat as programBurst: two racing creates can both
// pass — acceptable off-by-one on a spend cap, not a security boundary.
export async function intakeSessionBurst(
  userId: string,
  now: Date = new Date(),
): Promise<IntakeLimit> {
  const used = await prisma.intakeSession.count({
    where: {
      userId,
      createdAt: { gte: new Date(now.getTime() - INTAKE_SESSION_WINDOW_MS) },
    },
  });
  return { allowed: used < INTAKE_SESSIONS_PER_HOUR, used, limit: INTAKE_SESSIONS_PER_HOUR };
}

// The per-session turn budget — pure check over the server-side counter (only
// the route increments turnCount, so a tampered client transcript can't dodge
// it). `allowed: false` means the route must NOT run the agent: it marks the
// session exhausted and returns the terminal "use the form" response.
export function intakeTurnBudget(session: { turnCount: number }): IntakeLimit {
  return {
    allowed: session.turnCount < INTAKE_MAX_TURNS,
    used: session.turnCount,
    limit: INTAKE_MAX_TURNS,
  };
}
