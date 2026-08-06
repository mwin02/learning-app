// Zod schema for the operator triage API — POST /api/playground/reports.
// Sibling to pending-review-schema.ts, and a discriminated union for the same
// reason: each action carries different payload, and a curator or an autonomous
// reviewer both get a precise, self-describing contract.
//
// The union IS the routing table from docs/resource-reports-plan.md § R4 —
// deprecate/unlink/refile/edit/dismiss, each landing on machinery that already
// exists. See report-triage.ts for what each one delegates to.

import { z } from 'zod';
import { NOTE_MAX_CHARS } from '@/lib/report-view';

const base = {
  reportId: z.string().trim().min(1),
  // Default true: five reports of one dead link are one defect (plan § R4).
  resolveSiblings: z.boolean().default(true),
  // The operator's own words, appended to the composed `resolution`. Same cap as
  // the learner's note — it lands in the same column.
  note: z.string().trim().max(NOTE_MAX_CHARS).optional(),
};

// Mirrors ResourceUpdateFields (update-resource.ts's whitelist), including
// `requiresPurchase` — the field fix for a `paywalled` report, so a wrong access
// flag is corrected rather than costing the resource a deprecation.
const fields = z
  .object({
    durationMin: z.number().int().min(1).max(100_000).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    summary: z.string().trim().min(1).max(2_000).optional(),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    requiresPurchase: z.boolean().optional(),
  })
  .refine((f) => Object.keys(f).length > 0, 'Supply at least one field to edit.');

export const reportTriageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('deprecate_hard'), ...base }),
  z.object({ action: z.literal('deprecate_soft'), ...base }),
  z.object({ action: z.literal('unlink'), ...base }),
  z.object({ action: z.literal('dismiss'), ...base }),
  z.object({ action: z.literal('refile'), ...base, topic: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal('edit'), ...base, fields }),
]);

export type ReportTriageInput = z.infer<typeof reportTriageSchema>;
