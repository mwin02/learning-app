// Phase 2.5h-5: add/remove questions in a concept's bank (operator/agent only).
//
//   POST   /api/playground/concept-banks/questions   — append questions to a
//          concept's bank. Body { conceptId, questions: [{ kind, prompt, answer,
//          rubric }] }. Persisted with origin=user (operator-authored, the
//          resource-grounded upgrade over the generated seed set).
//   DELETE /api/playground/concept-banks/questions?id=<questionId> — drop one.
//
// Sibling to ../route.ts (GET worklist + PATCH mark-reviewed); same error envelope +
// withAdminAuth gate. Flat routes — see ../route.ts for why (no dynamic segments).
// MCQ options are embedded in `prompt` (no options column); we validate an MCQ
// carries ≥2 lettered options so the discovery API can't seed an unanswerable MCQ.

import { z, ZodError } from 'zod';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { prisma } from '@/lib/db';
import { ExerciseKind, Origin } from '@prisma/client';
import { mcqHasOptions } from '@/lib/agents/content/mcq-options';

export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

const postSchema = z.object({
  conceptId: z.string().min(1),
  questions: z
    .array(
      z
        .object({
          kind: z.nativeEnum(ExerciseKind),
          prompt: z.string().min(1).max(4000),
          answer: z.string().min(1).max(4000),
          rubric: z.string().min(1).max(4000),
        })
        // An MCQ with options missing from the prompt is unanswerable on reveal.
        .refine((q) => q.kind !== ExerciseKind.mcq || mcqHasOptions(q.prompt), {
          message: 'mcq prompt must contain at least two lettered options (e.g. "A) ...")',
        }),
    )
    .min(1)
    .max(50),
});

// POST — append operator-authored questions (origin=user).
export const POST = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Body must be valid JSON.');
  }

  let input: z.infer<typeof postSchema>;
  try {
    input = postSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(400, 'INVALID_INPUT', 'Invalid questions body.', err.issues);
    throw err;
  }

  const concept = await prisma.concept.findUnique({ where: { id: input.conceptId }, select: { id: true } });
  if (!concept) return errorResponse(404, 'NOT_FOUND', `No Concept '${input.conceptId}'.`);

  const { count } = await prisma.conceptQuestion.createMany({
    data: input.questions.map((q) => ({
      conceptId: input.conceptId,
      prompt: q.prompt,
      answer: q.answer,
      rubric: q.rubric,
      kind: q.kind,
      origin: Origin.user,
    })),
  });

  return Response.json({ conceptId: input.conceptId, added: count });
});

// DELETE — remove one question by id. Query: ?id=<questionId>.
export const DELETE = withAdminAuth(async (req) => {
  const id = new URL(req.url).searchParams.get('id')?.trim();
  if (!id) return errorResponse(400, 'INVALID_INPUT', 'Missing ?id=<questionId>.');

  const existing = await prisma.conceptQuestion.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return errorResponse(404, 'NOT_FOUND', `No ConceptQuestion '${id}'.`);

  await prisma.conceptQuestion.delete({ where: { id } });
  return Response.json({ deleted: id });
});
