// Reports R1: the report route's per-user burst cap. Mirrors rating-limits'
// ratingBurst in shape (count the user's rows touched inside a rolling window),
// with the same soft-limit race caveat — two concurrent requests can both read
// just-under-limit — which is harmless at this stake.
//
// Signal: the user's ResourceReport rows whose createdAt falls in the window.
// Deliberately NOT updatedAt — ResourceReport rows are written by others by design
// (the dead-link probe's resolve/stamp, operator triage), and @updatedAt bumps on
// every one of those, so an updatedAt window spends the learner's budget on writes
// they didn't make. createdAt is never rewritten.
//
// That column choice bounds FAN-OUT (a report on a new resource is a new row) but
// not REPETITION: a re-report upserts an existing row and creates none, so it never
// increments `used`. The unique (userId, resourceId, category) constraint caps the
// ROWS, which is what it was read to cap — but the cost the route pays is per
// REQUEST, and for dead_link that includes an inline outbound liveness probe. So
// repetition gets its own cap, reportRepeat, rather than a looser window here.

import { prisma } from '@/lib/db';
import {
  REPORT_BURST_PER_HOUR,
  REPORT_BURST_WINDOW_MS,
  REPORT_REPEAT_COOLDOWN_MS,
} from '@/lib/config';

export type ReportBurst = {
  allowed: boolean;
  used: number;
  limit: number;
};

export async function reportBurst(userId: string, now: Date = new Date()): Promise<ReportBurst> {
  const used = await prisma.resourceReport.count({
    where: {
      userId,
      createdAt: { gte: new Date(now.getTime() - REPORT_BURST_WINDOW_MS) },
    },
  });
  return { allowed: used < REPORT_BURST_PER_HOUR, used, limit: REPORT_BURST_PER_HOUR };
}

export type ReportRepeat = { allowed: true } | { allowed: false; retryAfterMs: number };

// Per-row cooldown on re-submissions of the same (user, resource, category). Pure:
// the route has already read the row to decide the reopen, so this costs no query.
//
// `updatedAt` is the right signal HERE for the same reason it is the wrong one in
// reportBurst. There, a write by the probe or by operator triage spends a budget the
// learner is meant to own, across every resource they ever reported. Here the scope
// is one row, and every writer of it is a reason to wait: the probe just re-checked
// this URL, or an operator just acted on this report — in both cases an immediate
// re-report has nothing new to say. A stale-but-real defect still gets through one
// cooldown later, so nothing is swallowed.
export function reportRepeat(
  existing: { updatedAt: Date } | null,
  now: Date = new Date()
): ReportRepeat {
  if (!existing) return { allowed: true };
  const elapsed = now.getTime() - existing.updatedAt.getTime();
  if (elapsed >= REPORT_REPEAT_COOLDOWN_MS) return { allowed: true };
  // Clamped so a row stamped in the future (clock skew between app instances)
  // can't advertise a wait longer than the cooldown itself.
  return { allowed: false, retryAfterMs: Math.min(REPORT_REPEAT_COOLDOWN_MS, REPORT_REPEAT_COOLDOWN_MS - elapsed) };
}
