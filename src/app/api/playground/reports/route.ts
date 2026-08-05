// /api/playground/reports — the operator triage API for learner-filed
// ResourceReports (R1/R2 intake → this queue).
//
// GET  — open reports grouped by resource, ranked by distinct reporters then age.
// POST — resolve one report: { reportId, action, … }. See report-triage-schema.ts
//        for the contract and report-triage.ts for what each action delegates to.
//
// Admin/operator-gated via withAdminAuth (NOT withAuth): never reachable by a
// signed-in customer, and 404 rather than 403 so it isn't enumerable. Same JSON
// contract drives the playground buttons and a future triage agent.

import { ZodError } from 'zod';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { reportTriageSchema } from '@/lib/api/report-triage-schema';
import { listReportTriage, resolveReport, REPORT_ROW_CAP } from '@/lib/curation/report-triage';
import { logError } from '@/lib/log';

// Prisma needs the Node runtime (not Edge).
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// ?limit=N caps the reports read (audit 7.2), so an agent can pull a bounded
// batch. Absent → REPORT_ROW_CAP.
export const GET = withAdminAuth(async (req) => {
  const raw = new URL(req.url).searchParams.get('limit');
  let limit = REPORT_ROW_CAP;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > REPORT_ROW_CAP) {
      return errorResponse(400, 'INVALID_INPUT', `\`limit\` must be an integer in 1..${REPORT_ROW_CAP}.`);
    }
    limit = n;
  }
  const { items, truncated } = await listReportTriage(limit);
  return Response.json({ resources: items, count: items.length, truncated });
});

export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = reportTriageSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  try {
    const result = await resolveReport(input);
    switch (result.kind) {
      case 'not_found':
        return errorResponse(404, 'NOT_FOUND', `Report ${input.reportId} not found.`);
      case 'not_open':
        return errorResponse(
          409,
          'INVALID_STATE',
          `Report is already '${result.state}'; no change applied.`,
        );
      case 'refused':
        return errorResponse(409, 'INVALID_STATE', result.reason);
      case 'resolved':
        return Response.json({
          reportId: result.reportId,
          action: result.action,
          state: result.state,
          resolution: result.resolution,
          alsoResolved: result.alsoResolved,
        });
    }
  } catch (err) {
    // Audit 1.6: never echo the raw exception — the full error is in the log.
    logError('reports.triage-failed', { reportId: input.reportId, action: input.action, err });
    return errorResponse(500, 'INTERNAL', 'Internal error resolving report.');
  }
});
