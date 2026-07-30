import { generateText } from 'ai';
import { getModel } from '@/lib/ai/models';
import { prisma } from '@/lib/db';
import { devBypass, getSessionUserId } from '@/lib/api/with-auth';
import { isAdmin } from '@/lib/api/with-admin-auth';
import { log, logError } from '@/lib/log';

export async function GET(request: Request) {
  const probe = new URL(request.url).searchParams.get('probe');

  // D1: readiness, not liveness — `SELECT 1` over the Prisma adapter, which is
  // what a container orchestrator (Cloud Run startup probe) should gate on: a
  // booted server that can't reach Postgres serves 500s on every real route.
  // Deliberately unauthenticated and content-free — it reveals only up/down,
  // never counts, schema, or the connection error (which can carry the host
  // and credentials). Details go to the server log, per the AI probe's rule.
  if (probe === 'db') {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return Response.json({ ok: true, db: 'up', ts: Date.now() });
    } catch (err) {
      logError('health.db-probe-failed', { err });
      return Response.json({ ok: false, db: 'down' }, { status: 503 });
    }
  }

  // H2 (audit 9.2): the AI probe fires a live (billed) model call, and B1's
  // throw probe deliberately 500s, so both are admin-only. A non-admin asking
  // for either gets the plain liveness body — same shape as no probe at all, so
  // the gated paths aren't enumerable.
  const gated = probe === 'ai' || probe === 'throw';
  if (!gated || !((await isAdmin(await getSessionUserId())) || devBypass())) {
    return Response.json({ ok: true, ts: Date.now() });
  }

  // Free-beta B1: the only way to prove the error-reporting chain works in a
  // deployed environment is to put an error into it. Uncaught on purpose — the
  // point is to exercise the path nothing else can reach on demand:
  // instrumentation.ts's onRequestError → logError (severity + stack in
  // `message`) → Cloud Logging → an Error Reporting group → the notification
  // channel. Run it after every deploy that touches logging, and once to
  // confirm a newly wired notification channel actually delivers.
  //
  // The message is fixed and self-identifying so the group it creates is
  // recognizable as a drill rather than a real regression, and so repeated
  // probes land in ONE group instead of littering Error Reporting with new ones
  // (which would each fire a new-group notification).
  if (probe === 'throw') {
    throw new Error('health.forced-throw — B1 error-reporting probe, not a real failure');
  }

  try {
    const { model, modelId, temperature, maxOutputTokens } = getModel('health');
    const { text, usage } = await generateText({
      model,
      temperature,
      maxOutputTokens,
      prompt: 'Reply with the single word: pong',
    });
    log('health.ai-probe', { modelId, usage });
    return Response.json({ ok: true, model: modelId, reply: text, usage });
  } catch (err) {
    // H2 (audit 9.2): don't echo err.message — provider errors can carry
    // project/model internals. Details go to the server log only.
    logError('health.ai-probe-failed', { err });
    return Response.json({ ok: false, error: 'AI probe failed' }, { status: 500 });
  }
}
