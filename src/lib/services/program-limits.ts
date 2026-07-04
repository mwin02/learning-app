// Phase 3c: the free-tier creation quota. The ONE place creation limits are
// decided — routes ask `programQuota(userId)` and compare, so when subscriptions
// arrive (Stripe phase) only this file learns about plans/tiers. Counts Programs
// created this UTC calendar month, excluding `failed` (a failed plan pass never
// burns quota; `partial` counts — Tracks were built and spend happened).

import { ProgramStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { FREE_PROGRAMS_PER_MONTH } from '@/lib/config';

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
