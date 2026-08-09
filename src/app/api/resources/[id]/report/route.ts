// Reports R1: file a defect report against a resource.
//
//   POST { category, lessonId?, note? }  — upsert the viewer's ResourceReport row
//                                          for this (resource, category).
//
// The DEFECT channel, next to rating/route.ts's taste channel: a vote's only lever
// is deprecation, while a report names which defect so triage can act on the right
// axis. Reports deliberately do not touch trustScore (docs/resource-reports-plan.md).
//
// Same shape as the rating route: real session required (a report needs an owner —
// the dev bypass's null userId gets a clean 401), zod-parsed body, burst cap after
// validation and before the lookup, non-enumerable 404 on an unknown resource.
//
// R2 hangs the dead-link liveness probe off this handler; this block only records.

import { z, ZodError } from 'zod';
import { ReportCategory } from '@prisma/client';
import { withAuth } from '@/lib/api/with-auth';
import { prisma } from '@/lib/db';
import { logWarn } from '@/lib/log';
import { reportBurst } from '@/lib/services/report-limits';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export const NOTE_MAX_CHARS = 500;

const bodySchema = z.object({
  // The Prisma enum object, so a new ReportCategory is accepted here the moment
  // it exists in the schema — no second hand-maintained list to drift.
  category: z.enum(ReportCategory),
  lessonId: z.string().min(1).optional(),
  note: z.string().trim().max(NOTE_MAX_CHARS).optional(),
});

export const POST = withAuth<Ctx>(async (req, session, ctx) => {
  if (!session.userId) {
    return Response.json(
      { error: 'Reporting requires a signed-in user.', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: 'Request body is not valid JSON.', code: 'INVALID_INPUT' },
      { status: 400 }
    );
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return Response.json(
        { error: 'Request body failed validation.', code: 'INVALID_INPUT', details: err.flatten() },
        { status: 400 }
      );
    }
    throw err;
  }

  // Per-user burst cap. Checked after validation (a malformed body should say so,
  // not hit a confusing 429) and before the resource lookup/write, so a
  // rate-limited caller spends nothing. Far tighter than the vote cap: reports are
  // rare and deliberate, and this one carries free text (see config.ts).
  const burst = await reportBurst(session.userId);
  if (!burst.allowed) {
    return Response.json(
      {
        error: 'Too many reports recently — try again in a bit.',
        code: 'RATE_LIMITED',
        details: { used: burst.used, limit: burst.limit },
      },
      { status: 429 }
    );
  }

  const { id: resourceId } = await ctx.params;
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true },
  });
  if (!resource) {
    return Response.json({ error: 'Resource not found.', code: 'NOT_FOUND' }, { status: 404 });
  }

  // lessonId is best-effort PLACEMENT CONTEXT, not the subject of the report, so an
  // id we can't resolve is dropped rather than refused: the defect is still real and
  // worth recording. Checked rather than passed straight through because an unknown
  // id would otherwise surface as an FK violation — a 500 for a report we could keep.
  let lessonId: string | null = null;
  if (body.lessonId) {
    const lesson = await prisma.lesson.findUnique({
      where: { id: body.lessonId },
      select: { id: true },
    });
    if (lesson) lessonId = lesson.id;
    else logWarn('report.unknown_lesson', { resourceId, lessonId: body.lessonId });
  }

  const note = body.note ? body.note : null;
  // Re-reporting REOPENS but never ERASES. Reopening is about the report's state:
  // a resolved or dismissed report the learner raises again is fresh evidence the
  // fix didn't take, so the operator sees it once more and the stale resolution
  // doesn't linger next to an open complaint. The evidence itself is additive —
  // `lessonId` and `note` are only overwritten when the new submission actually
  // supplies one, because a re-report can legitimately carry neither. The same
  // complaint raised from the library page has no ambient lesson, and an empty
  // note field means "I didn't retype it", not "I retract it". Last-write-wins
  // would make the ordinary case destructive: it would wipe the placement context
  // that R4 triages `wrong_lesson_fit` on, and the free text that is the only
  // evidence a `other` report carries at all.
  const evidence = {
    ...(lessonId ? { lessonId } : {}),
    ...(note ? { note } : {}),
  };
  const report = await prisma.resourceReport.upsert({
    where: {
      userId_resourceId_category: {
        userId: session.userId,
        resourceId,
        category: body.category,
      },
    },
    update: { ...evidence, state: 'open', resolution: null, resolvedAt: null },
    create: { userId: session.userId, resourceId, lessonId, note, category: body.category },
    select: { id: true, category: true, state: true },
  });

  return Response.json({ ok: true, report });
});
