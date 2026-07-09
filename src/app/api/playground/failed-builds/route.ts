// POST /api/playground/failed-builds — operator actions on the failed-builds
// triage page (retry / delete). Admin-only (withAdminAuth — NEVER withAuth; a
// signed-in customer must not reach it), same error envelope as the sibling
// playground routes. Quick DB writes only (no LLM), so no extended maxDuration.
//
// retry:  re-enqueue a `failed` CourseRequest — flip → `queued`, clear
//         error/claimedAt so the running worker rebuilds it next tick. If it's a
//         program child, ALSO reset a `partial`/`failed` parent Program back to
//         `building`: maybeAssembleProgram only finalizes from planning/building
//         (program.ts), so without this the re-fulfilled child would never roll
//         the Program up out of `partial`.
// delete: remove a terminal failed row (courseRequest | program | track); FK
//         cascades handle children. Guarded to failed-state rows so this surface
//         can't nuke a healthy Program/Track.

import { z, ZodError } from 'zod';
import { CourseRequestStatus, ProgramStatus, TrackStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { withAdminAuth } from '@/lib/api/with-admin-auth';

export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry'), courseRequestId: z.string().min(1) }),
  z.object({
    action: z.literal('delete'),
    kind: z.enum(['courseRequest', 'program', 'track']),
    id: z.string().min(1),
  }),
]);

async function retry(courseRequestId: string): Promise<Response> {
  const cr = await prisma.courseRequest.findUnique({
    where: { id: courseRequestId },
    select: { status: true, programId: true },
  });
  if (!cr) return errorResponse(404, 'NOT_FOUND', 'CourseRequest not found.');
  if (cr.status !== CourseRequestStatus.failed) {
    return errorResponse(409, 'INVALID_STATE', `CourseRequest is ${cr.status}, not failed — nothing to retry.`);
  }

  const { programReset } = await prisma.$transaction(async (tx) => {
    await tx.courseRequest.update({
      where: { id: courseRequestId },
      data: { status: CourseRequestStatus.queued, error: null, claimedAt: null },
    });
    let programReset = false;
    if (cr.programId) {
      const { count } = await tx.program.updateMany({
        where: { id: cr.programId, status: { in: [ProgramStatus.partial, ProgramStatus.failed] } },
        data: { status: ProgramStatus.building },
      });
      programReset = count > 0;
    }
    return { programReset };
  });

  return Response.json({ requeued: true, programReset });
}

// Only a failed-state row is deletable from this surface — deleting a healthy
// Program/Track here would be a footgun (and a `partial` Program still owns its
// successfully-built children).
async function del(kind: 'courseRequest' | 'program' | 'track', id: string): Promise<Response> {
  if (kind === 'courseRequest') {
    const row = await prisma.courseRequest.findUnique({ where: { id }, select: { status: true } });
    if (!row) return errorResponse(404, 'NOT_FOUND', 'CourseRequest not found.');
    if (row.status !== CourseRequestStatus.failed) {
      return errorResponse(409, 'INVALID_STATE', `CourseRequest is ${row.status}, not failed.`);
    }
    await prisma.courseRequest.delete({ where: { id } });
  } else if (kind === 'program') {
    const row = await prisma.program.findUnique({ where: { id }, select: { status: true } });
    if (!row) return errorResponse(404, 'NOT_FOUND', 'Program not found.');
    if (row.status !== ProgramStatus.failed) {
      return errorResponse(409, 'INVALID_STATE', `Program is ${row.status}, not failed — only a failed plan-pass Program is deletable here.`);
    }
    await prisma.program.delete({ where: { id } });
  } else {
    const row = await prisma.track.findUnique({ where: { id }, select: { status: true } });
    if (!row) return errorResponse(404, 'NOT_FOUND', 'Track not found.');
    if (row.status !== TrackStatus.failed) {
      return errorResponse(409, 'INVALID_STATE', `Track is ${row.status}, not failed.`);
    }
    await prisma.track.delete({ where: { id } });
  }
  return Response.json({ deleted: true, kind });
}

export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Body must be valid JSON.');
  }

  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Invalid failed-builds action body.', err.issues);
    }
    throw err;
  }

  if (input.action === 'retry') return retry(input.courseRequestId);
  return del(input.kind, input.id);
});
