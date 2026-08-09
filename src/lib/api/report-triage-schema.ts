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
import { resourceUpdateSchema } from '@/lib/api/resource-update-schema';

const base = {
  reportId: z.string().trim().min(1),
  // Default true: five reports of one dead link are one defect (plan § R4).
  resolveSiblings: z.boolean().default(true),
  // The operator's own words, appended to the composed `resolution`. Same cap as
  // the learner's note — it lands in the same column.
  note: z.string().trim().max(NOTE_MAX_CHARS).optional(),
};

// THE canonical edit contract, imported rather than restated (F3a). Both this
// route and PATCH /api/playground/resources land on the same `updateResource`, so
// a second definition here was a second set of bounds on one write — `durationMin`
// was capped at 100_000 on this side and 6000 there, and the looser number feeds
// the attach ceiling and the track time allocator. Includes `requiresPurchase` —
// the field fix for a `paywalled` report, so a wrong access flag is corrected
// rather than costing the resource a deprecation.
const fields = resourceUpdateSchema.shape.fields;

export const reportTriageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('deprecate_hard'), ...base }),
  z.object({ action: z.literal('deprecate_soft'), ...base }),
  z.object({ action: z.literal('unlink'), ...base }),
  z.object({ action: z.literal('dismiss'), ...base }),
  z.object({ action: z.literal('refile'), ...base, topic: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal('edit'), ...base, fields }),
]);

export type ReportTriageInput = z.infer<typeof reportTriageSchema>;
