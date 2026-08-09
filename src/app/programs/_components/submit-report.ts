// Reports R3: the ONE place a client POSTs /api/resources/[id]/report, mirroring
// submit-program.ts. The route's error vocabulary maps to copy exactly once (in
// report-view.ts), and the dead-link verdict R2 rides back on the response is
// narrowed here so the dialog only ever sees an acknowledgement string.

import type { ReportCategory } from '@prisma/client';
import type { DeadLinkOutcome } from '@/lib/curation/verify-dead-link';
import { acknowledgementFor, reportErrorMessage } from '@/lib/report-view';

export type SubmitReportPayload = {
  resourceId: string;
  category: ReportCategory;
  lessonId?: string;
  note?: string;
};

export type SubmitReportResult = { ok: true; message: string } | { ok: false; message: string };

const OUTCOMES: readonly DeadLinkOutcome[] = [
  'confirmed_dead',
  'already_deprecated',
  'inconclusive',
  'appears_live',
  'skipped',
];

// `res.json()` is untyped, so the two fields the UI reads are narrowed rather than
// trusted: an unrecognized outcome falls through to the generic acknowledgement.
function readOutcome(data: unknown): DeadLinkOutcome | undefined {
  if (!data || typeof data !== 'object' || !('deadLink' in data)) return undefined;
  const deadLink = (data as { deadLink: unknown }).deadLink;
  if (!deadLink || typeof deadLink !== 'object' || !('outcome' in deadLink)) return undefined;
  const outcome = (deadLink as { outcome: unknown }).outcome;
  return OUTCOMES.find((o) => o === outcome);
}

function readCode(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('code' in data)) return undefined;
  return (data as { code: unknown }).code;
}

// REPORT_COOLDOWN's copy needs the remaining wait, which is the only part of that
// refusal the learner can act on. Narrowed like the fields above and left as
// `unknown` — reportErrorMessage does the validating, so an absent or junk value
// still produces a sentence.
function readRetryAfterMs(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('details' in data)) return undefined;
  const details = (data as { details: unknown }).details;
  if (!details || typeof details !== 'object' || !('retryAfterMs' in details)) return undefined;
  return (details as { retryAfterMs: unknown }).retryAfterMs;
}

export async function submitReport(payload: SubmitReportPayload): Promise<SubmitReportResult> {
  const { resourceId, ...body } = payload;
  let res: Response;
  try {
    res = await fetch(`/api/resources/${resourceId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: reportErrorMessage(undefined) };
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, message: reportErrorMessage(readCode(data), readRetryAfterMs(data)) };
  }
  return { ok: true, message: acknowledgementFor(readOutcome(data)) };
}
