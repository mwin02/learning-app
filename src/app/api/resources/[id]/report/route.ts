// Reports R1: file a defect report against a resource.
//
//   POST { category, lessonId?, note? }  — upsert the viewer's ResourceReport row
//                                          for this (resource, category).
//
// The DEFECT channel, next to rating/route.ts's taste channel: a vote's only lever
// is deprecation, while a report names which defect so triage can act on the right
// axis. Reports deliberately do not touch trustScore (resource-reports.md).
//
// Same shape as the rating route: real session required (a report needs an owner —
// the dev bypass's null userId gets a clean 401), zod-parsed body, burst cap after
// validation and before the lookup, non-enumerable 404 on an unknown resource.
//
// R2 hangs the dead-link liveness probe off this handler (see verify-dead-link.ts):
// a `dead_link` report gets an inline verdict, every other category just records.

import { z, ZodError } from 'zod';
import { ReportCategory } from '@prisma/client';
import { withAuth } from '@/lib/api/with-auth';
import { prisma } from '@/lib/db';
import { planReopen, resolveLessonContext } from '@/lib/services/report-intake';
import { reportBurst, reportRepeat } from '@/lib/services/report-limits';
import { verifyDeadLink } from '@/lib/curation/verify-dead-link';
// R3 shares the cap with the dialog's textarea (report-view.ts is type-only-server-free).
import { NOTE_MAX_CHARS } from '@/lib/report-view';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

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

  const lessonId = body.lessonId ? await resolveLessonContext(resourceId, body.lessonId) : null;
  const note = body.note ? body.note : null;

  // Read before the upsert because the reopen rule is a function of the row's own
  // settled resolution, which an update payload can't reference.
  const key = {
    userId_resourceId_category: { userId: session.userId, resourceId, category: body.category },
  };
  const existing = await prisma.resourceReport.findUnique({
    where: key,
    select: { resolution: true, priorResolution: true, updatedAt: true },
  });

  // Repetition cap. Separate from the burst cap above because the burst counts
  // createdAt and a re-report creates nothing — without this, one existing row is a
  // licence to run the handler (and, for dead_link, its outbound probe) in a loop.
  // Checked before the upsert so a refused re-report writes nothing at all.
  const repeat = reportRepeat(existing);
  if (!repeat.allowed) {
    return Response.json(
      {
        error: 'You already reported this resource recently — try again in a bit.',
        // Its own code, not RATE_LIMITED: the two 429s have different scopes, and
        // report-view.ts maps copy off the code alone (see reportErrorMessage).
        code: 'REPORT_COOLDOWN',
        details: { retryAfterMs: repeat.retryAfterMs },
      },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(repeat.retryAfterMs / 1000)) } }
    );
  }

  const report = await prisma.resourceReport.upsert({
    where: key,
    update: planReopen(existing, { lessonId, note }),
    create: { userId: session.userId, resourceId, lessonId, note, category: body.category },
    select: { id: true, category: true, state: true },
  });

  // R2: dead_link is the one category a machine can settle, so it is verified
  // inline (bounded by liveness's 6s) — AFTER the upsert, so a re-report that
  // reopened the row ends on the probe's verdict rather than the reopen's null.
  // The verdict rides back in the response so the UI can say what happened
  // instead of a generic thank-you; it never throws, so a probe failure still
  // returns a recorded report.
  if (body.category === 'dead_link') {
    const deadLink = await verifyDeadLink({ resourceId, reportId: report.id });
    return Response.json({
      ok: true,
      report: { ...report, state: deadLink.state },
      deadLink: { outcome: deadLink.outcome, detail: deadLink.detail },
    });
  }

  return Response.json({ ok: true, report });
});
