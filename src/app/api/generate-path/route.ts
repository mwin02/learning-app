// POST /api/generate-path — HTTP boundary for the curriculum agent.
//
// 2d.1 (this file): auth gate (placeholder), input validation, topic-validity
// gate, stub success response. No curriculum-agent call, no DB writes yet.
// 2d.2: replaces the stub with PathService that calls generateCurriculum
// and persists Path + PathItem rows in a transaction (session.userId →
// Path.createdById).
//
// Access control is delegated to withAuth (see src/lib/api/with-auth.ts).
// Today that's a placeholder env check (DEV_AUTH=1); Phase 3 swaps the
// internals to a real Supabase session lookup without touching this file.

import { ZodError } from 'zod';
import { generatePathInputSchema } from '@/lib/api/generate-path-schema';
import { withAuth } from '@/lib/api/with-auth';
import { validateTopic } from '@/lib/topic-gate';

// Vercel Hobby allows up to 60s per function. Cold-topic runs (web fallback
// + Pro discovery + validation) can exceed this; those will fail until we
// move to Cloud Run. Documented in docs/ROADMAP.md.
export const maxDuration = 60;

// Prisma + the Vertex SDK need the Node runtime, not Edge.
export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'TOPIC_REJECTED' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

export const POST = withAuth(async (req, _session) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body is not valid JSON.');
  }

  let input;
  try {
    input = generatePathInputSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, 'INVALID_INPUT', 'Request body failed validation.', err.flatten());
    }
    throw err;
  }

  let gate;
  try {
    gate = await validateTopic(input.topic);
  } catch (err) {
    console.error('[generate-path] topic-gate failure', err);
    return errorResponse(500, 'INTERNAL', 'Internal error.');
  }

  if (!gate.valid) {
    return errorResponse(400, 'TOPIC_REJECTED', 'Topic is not within the supported domains.', {
      reason: gate.reason,
    });
  }

  // Stub success for 2d.1. The canonical topic from the gate replaces the
  // raw input so downstream (2d.2) persists the normalized slug.
  const validatedInput = { ...input, topic: gate.canonical };
  return Response.json({
    pathId: null,
    status: 'validated',
    input: validatedInput,
    subject: gate.subject,
  });
});
