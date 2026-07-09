// Phase 3c: the free-tier creation quota. The ONE place creation limits are
// decided — routes ask `programQuota(userId)` and compare, so when subscriptions
// arrive (Stripe phase) only this file learns about plans/tiers. Counts Programs
// created this UTC calendar month, excluding `failed` (a failed plan pass never
// burns quota; `partial` counts — Tracks were built and spend happened).

import { createHash } from 'node:crypto';
import { ProgramStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { GenerateProgramInput } from '@/lib/api/generate-program-schema';
import {
  FREE_PROGRAMS_PER_MONTH,
  PROGRAM_BURST_PER_HOUR,
  PROGRAM_BURST_WINDOW_MS,
  PROGRAM_DEDUP_WINDOW_MS,
} from '@/lib/config';

export type ProgramQuota = {
  allowed: boolean;
  used: number;
  limit: number;
};

// Pure + exported for the colocated unit test; UTC so the window doesn't shift
// with server locale.
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function programQuota(userId: string, now: Date = new Date()): Promise<ProgramQuota> {
  const used = await prisma.program.count({
    where: {
      userId,
      createdAt: { gte: monthStartUtc(now) },
      status: { not: ProgramStatus.failed },
    },
  });
  return { allowed: used < FREE_PROGRAMS_PER_MONTH, used, limit: FREE_PROGRAMS_PER_MONTH };
}

// H1: canonical fingerprint of a creation payload — the idempotency key persisted
// on Program.inputHash. Pure + exported for the colocated unit test. Normalization
// is deliberately light: case + whitespace folding (a resubmit that only differs
// in capitalization or spacing is the same intent) and antiList order-insensitivity;
// any change to the numbers or the words is a genuinely different request.
export function programInputHash(input: GenerateProgramInput): string {
  const canon = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const payload = JSON.stringify([
    canon(input.goal),
    canon(input.background ?? ''),
    input.totalHoursPerWeek,
    input.totalWeeks,
    (input.antiList ?? []).map(canon).sort(),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export type ProgramBurst = {
  allowed: boolean;
  used: number;
  limit: number;
};

// H1: the short-window creation cap. Counts ALL statuses — unlike programQuota,
// a `failed` attempt counts here, because the burst cap's job is to stop a loop
// of requests that each burn the synchronous plan pass (an LLM call) regardless
// of whether they produce a usable Program. Same soft-limit race caveat as the
// quota (documented on FREE_PROGRAMS_PER_MONTH).
export async function programBurst(userId: string, now: Date = new Date()): Promise<ProgramBurst> {
  const used = await prisma.program.count({
    where: {
      userId,
      createdAt: { gte: new Date(now.getTime() - PROGRAM_BURST_WINDOW_MS) },
    },
  });
  return { allowed: used < PROGRAM_BURST_PER_HOUR, used, limit: PROGRAM_BURST_PER_HOUR };
}

// H1: idempotent-submit lookup. A non-failed Program by the same user with the
// same payload hash inside the dedup window IS this request — the route returns
// its id as a 202 instead of creating a sibling. Failed rows never match: an
// immediate retry after a failed plan is legitimate, not a duplicate.
export async function findRecentDuplicate(
  userId: string,
  inputHash: string,
  now: Date = new Date(),
): Promise<{ id: string; status: ProgramStatus } | null> {
  return prisma.program.findFirst({
    where: {
      userId,
      inputHash,
      status: { not: ProgramStatus.failed },
      createdAt: { gte: new Date(now.getTime() - PROGRAM_DEDUP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
}
