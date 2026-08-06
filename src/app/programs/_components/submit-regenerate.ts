// Reports R7: the ONE place a client talks to
// /api/programs/[programId]/tracks/[trackId]/regenerate, mirroring submit-report.
// The route's refusal vocabulary maps to copy exactly once (in rebuild-view.ts),
// and the GET payload is zod-parsed before the dialog reads a count off it.

import {
  ENQUEUED_MESSAGE,
  rebuildErrorMessage,
  rebuildStatusSchema,
  type RebuildEdits,
  type RebuildStatus,
} from '@/lib/rebuild-view';

export type RebuildStatusResult = { ok: true; status: RebuildStatus } | { ok: false; message: string };
export type SubmitRegenerateResult = { ok: true; message: string } | { ok: false; message: string };

function readCode(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('code' in data)) return undefined;
  return (data as { code: unknown }).code;
}

// The quota limit rides on the 429's `details` so the refusal copy can name it.
function readLimit(data: unknown): number | undefined {
  if (!data || typeof data !== 'object' || !('details' in data)) return undefined;
  const details = (data as { details: unknown }).details;
  if (!details || typeof details !== 'object' || !('limit' in details)) return undefined;
  const limit = (details as { limit: unknown }).limit;
  return typeof limit === 'number' ? limit : undefined;
}

function endpoint(programId: string, trackId: string): string {
  return `/api/programs/${programId}/tracks/${trackId}/regenerate`;
}

export async function fetchRebuildStatus(
  programId: string,
  trackId: string,
): Promise<RebuildStatusResult> {
  let res: Response;
  try {
    res = await fetch(endpoint(programId, trackId));
  } catch {
    return { ok: false, message: rebuildErrorMessage(undefined) };
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: rebuildErrorMessage(readCode(data), readLimit(data)) };
  const parsed = rebuildStatusSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: rebuildErrorMessage(undefined) };
  return { ok: true, status: parsed.data };
}

export async function submitRegenerate(
  programId: string,
  trackId: string,
  edits: RebuildEdits,
): Promise<SubmitRegenerateResult> {
  let res: Response;
  try {
    res = await fetch(endpoint(programId, trackId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edits),
    });
  } catch {
    return { ok: false, message: rebuildErrorMessage(undefined) };
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: rebuildErrorMessage(readCode(data), readLimit(data)) };
  return { ok: true, message: ENQUEUED_MESSAGE };
}
