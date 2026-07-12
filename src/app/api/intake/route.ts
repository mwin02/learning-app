// POST /api/intake — one turn of the /programs/new chat intake conversation.
//
// The server is the draft authority (plan non-negotiable): each turn loads the
// session's OWN persisted draft + turnCount, runs the agent, and persists the
// update. The client-held transcript is conversational context + display
// history only — a tampered transcript can't inflate the draft past the merge
// clamp or dodge the turn counter, and it is never stored (no message rows,
// ever). Submission stays out of here entirely: on `ready` the CLIENT posts
// the draft to the public /api/generate-program route, so quota (3c), burst +
// dedup (H1), Origin/CSRF (H2), and Zod validation all apply unchanged.
//
// Limits (intake-limits.ts): INTAKE_SESSIONS_PER_HOUR on session create,
// INTAKE_MAX_TURNS on the session row — worst case 75 Flash calls/user/hour.

import { z, ZodError } from 'zod';
import { IntakeSessionStatus } from '@prisma/client';
import { withAuth } from '@/lib/api/with-auth';
import { addUsageToSnapshot, log, logError, runWithTrace, type UsageSnapshot } from '@/lib/log';
import { prisma } from '@/lib/db';
import {
  INTAKE_MAX_TURNS,
  intakeSessionBurst,
  intakeTurnBudget,
} from '@/lib/services/intake-limits';
import { intakeTurn, type IntakeDraft } from '@/lib/agents/intake/turn';

// Prisma + the Vertex SDK need the Node runtime. One Flash structured call per
// turn (~1-2s) stays far under the cap.
export const maxDuration = 60;
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SESSION_CLOSED' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// Terminal turn-budget response — 200, not an error: the UI renders this reply
// and points at the form fallback (the chat's designed escape hatch).
const EXHAUSTED_REPLY =
  'We’ve hit the length limit for this conversation. Your answers so far aren’t lost — switch to the form below to finish creating your program.';

// Body limits per the plan: message ≤ 1,000 chars; transcript messages ≤ 1,000
// chars each — a resent history can't balloon the prompt. The transcript is
// context-only, so an over-long one is SLICED to the newest INTAKE_MAX_TURNS × 2
// messages in the handler rather than rejected: the client's mirror constant
// can't know a server-side env override of INTAKE_MAX_TURNS, and a cap mismatch
// must degrade to trimmed context, never a 400 that kills the conversation.
// The Zod max is only an abuse backstop on raw body size.
const TRANSCRIPT_HARD_CAP = 200;
const bodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(1000),
  transcript: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(1000),
      }),
    )
    .max(TRANSCRIPT_HARD_CAP)
    .default([]),
});

export const POST = withAuth(async (req, session) =>
  runWithTrace(crypto.randomUUID(), async () => {
    // Real sessions only — an IntakeSession row needs an owner, and the limits
    // are per-user. The dev bypass's null userId is rejected (enroll pattern).
    if (!session.userId) {
      return errorResponse(401, 'UNAUTHENTICATED', 'The intake chat requires a signed-in user.');
    }
    const userId = session.userId;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
    }

    let body;
    try {
      body = bodySchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
      }
      throw err;
    }

    // Load-or-create the session row (the rate-limit anchor + draft authority).
    let intakeSession;
    if (body.sessionId) {
      // Filtering by userId makes another user's sessionId indistinguishable
      // from a nonexistent one (non-enumerable 404).
      intakeSession = await prisma.intakeSession.findFirst({
        where: { id: body.sessionId, userId },
      });
      if (!intakeSession) {
        return errorResponse(404, 'NOT_FOUND', 'No such intake session.');
      }
      if (intakeSession.status === IntakeSessionStatus.exhausted) {
        // Idempotent terminal answer — a stale client re-sending into an
        // exhausted session gets the same fallback, not an error.
        return Response.json({ sessionId: intakeSession.id, exhausted: true, reply: EXHAUSTED_REPLY });
      }
      if (intakeSession.status !== IntakeSessionStatus.active) {
        return errorResponse(409, 'SESSION_CLOSED', 'This intake session is closed.');
      }
    } else {
      const burst = await intakeSessionBurst(userId);
      if (!burst.allowed) {
        return errorResponse(
          429,
          'RATE_LIMITED',
          `Too many chat sessions started recently — try again in a bit (limit ${burst.limit}/hour), or use the form.`,
          { used: burst.used, limit: burst.limit },
        );
      }
      intakeSession = await prisma.intakeSession.create({ data: { userId } });
      log('intake.session-created', { sessionId: intakeSession.id, userId });
    }

    // Turn budget — checked BEFORE the LLM call so an at-budget session never
    // spends another Flash call. active → exhausted is the only status
    // transition wired in v1 (submitted/abandoned write-backs are deferred).
    const budget = intakeTurnBudget(intakeSession);
    if (!budget.allowed) {
      await prisma.intakeSession.update({
        where: { id: intakeSession.id },
        data: { status: IntakeSessionStatus.exhausted },
      });
      log('intake.session-exhausted', { sessionId: intakeSession.id, turns: budget.used });
      return Response.json({ sessionId: intakeSession.id, exhausted: true, reply: EXHAUSTED_REPLY });
    }

    // Run the turn against the SERVER-persisted draft. The client transcript
    // is context only — sliced to the newest MAX_TURNS × 2 messages (see
    // bodySchema note); the newest message is appended here.
    const draft = (intakeSession.draft ?? {}) as IntakeDraft;
    const transcript = [
      ...body.transcript.slice(-(INTAKE_MAX_TURNS * 2)),
      { role: 'user' as const, content: body.message },
    ];
    let result;
    try {
      result = await intakeTurn({ transcript, draft });
    } catch (err) {
      // The agent already retried once internally; a turn that still failed is
      // a server fault. The turn is NOT counted (nothing was extracted).
      logError('intake.turn-failed', { sessionId: intakeSession.id, err });
      return errorResponse(500, 'INTERNAL', 'Internal error.');
    }

    const usage = addUsageToSnapshot(
      (intakeSession.usage as UsageSnapshot | null) ?? null,
      'intake.turn',
      result.usage,
    );
    const turnCount = intakeSession.turnCount + 1;
    await prisma.intakeSession.update({
      where: { id: intakeSession.id },
      data: {
        draft: result.draft,
        turnCount,
        ...(usage ? { usage } : {}),
      },
    });

    log('intake.turn', {
      sessionId: intakeSession.id,
      userId,
      turn: turnCount,
      ready: result.ready,
      done: result.done,
      totalTokens: result.usage?.totalTokens ?? 0,
    });

    // `ready: true` ⇒ `draft` parses against generateProgramInputSchema — the
    // client renders the confirmation card from THIS draft, which is exactly
    // what it will POST to /api/generate-program.
    return Response.json({
      sessionId: intakeSession.id,
      reply: result.reply,
      draft: result.draft,
      ready: result.ready,
    });
  }),
);
