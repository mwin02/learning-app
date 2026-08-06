// Reports R1: the report route's per-user burst cap. Mirrors rating-limits'
// ratingBurst in shape (count the user's rows touched inside a rolling window),
// with the same soft-limit race caveat — two concurrent requests can both read
// just-under-limit — which is harmless at this stake.
//
// Signal: the user's ResourceReport rows whose updatedAt falls in the window. A
// re-report of the same (resource, category) upserts and bumps updatedAt via
// @updatedAt, so re-submissions count too; unlike a vote there is no clear verb
// that deletes the row, so the rating limiter's churn gap doesn't exist here.

import { prisma } from '@/lib/db';
import { REPORT_BURST_PER_HOUR, REPORT_BURST_WINDOW_MS } from '@/lib/config';

export type ReportBurst = {
  allowed: boolean;
  used: number;
  limit: number;
};

export async function reportBurst(userId: string, now: Date = new Date()): Promise<ReportBurst> {
  const used = await prisma.resourceReport.count({
    where: {
      userId,
      updatedAt: { gte: new Date(now.getTime() - REPORT_BURST_WINDOW_MS) },
    },
  });
  return { allowed: used < REPORT_BURST_PER_HOUR, used, limit: REPORT_BURST_PER_HOUR };
}
