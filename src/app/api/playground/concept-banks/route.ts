// Phase 2.5h-5: the concept question-bank discovery surface (operator/agent only).
//
//   GET   /api/playground/concept-banks         — the "weak banks, oldest first"
//         worklist: concepts whose bank is still unreviewed (bankReviewed=false),
//         ordered by Concept.createdAt asc, each with its questions AND its resource
//         URLs — so an operator can open the sources and author resource-grounded
//         questions in one place (POST below), then mark it reviewed (PATCH).
//   PATCH /api/playground/concept-banks         — flip a concept's bankReviewed
//         (mark a bank done, or re-open it).
//
// Flat + body/query-based (no dynamic segments): withAdminAuth wraps (req, session)
// and doesn't forward Next's route context, and every sibling playground route is
// flat too. Question add/remove live in ./questions/route.ts. Same error envelope +
// withAdminAuth gate as build-track / map-edit (NEVER withAuth — internal only).

import { z, ZodError } from 'zod';
import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INTERNAL';

function errorResponse(status: number, code: ErrorCode, error: string, details?: unknown) {
  const body: { error: string; code: ErrorCode; details?: unknown } = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// GET — the discovery worklist. Query: ?includeReviewed=1 (show reviewed too),
// ?pathId=<id> (scope to one Path), ?limit=<n> (default 100, max 500).
export const GET = withAdminAuth(async (req) => {
  const url = new URL(req.url);
  const includeReviewed = url.searchParams.get('includeReviewed') === '1';
  const pathId = url.searchParams.get('pathId')?.trim() || undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

  const concepts = await prisma.concept.findMany({
    where: {
      // The worklist: never-reviewed banks (bankReviewed=false) PLUS reviewed banks
      // whose grounding resources have since changed (bankStaleReason set, Phase 2.5i).
      // ?includeReviewed=1 drops the filter to show settled banks too.
      ...(includeReviewed ? {} : { OR: [{ bankReviewed: false }, { bankStaleReason: { not: null } }] }),
      ...(pathId ? { pathId } : {}),
    },
    // Oldest first — the operator works the backlog front-to-back.
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      slug: true,
      title: true,
      membership: true,
      isOnRamp: true,
      bankReviewed: true,
      bankStaleReason: true,
      createdAt: true,
      pathId: true,
      path: { select: { topic: true } },
      questions: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true, prompt: true, answer: true, rubric: true, origin: true, createdAt: true },
      },
      // Resource URLs for one-place authoring — open these, write grounded questions.
      resources: {
        orderBy: { coverageScore: 'desc' },
        select: {
          role: true,
          coverageScore: true,
          resource: { select: { id: true, title: true, url: true, type: true } },
        },
      },
    },
  });

  const items = concepts.map((c) => ({
    conceptId: c.id,
    slug: c.slug,
    title: c.title,
    topic: c.path.topic,
    pathId: c.pathId,
    membership: c.membership,
    isOnRamp: c.isOnRamp,
    bankReviewed: c.bankReviewed,
    bankStaleReason: c.bankStaleReason,
    // Why this concept is on the worklist, for operator triage. A reviewed-but-stale
    // bank surfaces its change kind ('primary_changed' ranks above 'resource_removed');
    // an unreviewed bank is just 'unreviewed'. (A stale flag only ever exists on a
    // reviewed concept, so stale wins when both could apply.)
    reason: c.bankStaleReason ?? (c.bankReviewed ? 'reviewed' : 'unreviewed'),
    createdAt: c.createdAt,
    questionCount: c.questions.length,
    questions: c.questions,
    resources: c.resources.map((r) => ({
      id: r.resource.id,
      title: r.resource.title,
      url: r.resource.url,
      type: r.resource.type,
      role: r.role,
      coverageScore: r.coverageScore,
    })),
  }));

  return Response.json({ count: items.length, concepts: items });
});

const patchSchema = z.object({
  conceptId: z.string().min(1),
  // Defaults to true (mark done); pass false to re-open a bank for more work.
  bankReviewed: z.boolean().default(true),
});

// PATCH — mark a concept's bank reviewed (or re-open it).
export const PATCH = withAdminAuth(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Body must be valid JSON.');
  }

  let input: z.infer<typeof patchSchema>;
  try {
    input = patchSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(400, 'INVALID_INPUT', 'Invalid PATCH body.', err.issues);
    throw err;
  }

  const existing = await prisma.concept.findUnique({ where: { id: input.conceptId }, select: { id: true } });
  if (!existing) return errorResponse(404, 'NOT_FOUND', `No Concept '${input.conceptId}'.`);

  // Re-marking the bank (reviewed OR re-opened) is the operator's fresh decision, so
  // always clear any stale flag (Phase 2.5i) — the concept leaves the worklist on
  // review, or rejoins it as a plain unreviewed entry on re-open.
  const updated = await prisma.concept.update({
    where: { id: input.conceptId },
    data: { bankReviewed: input.bankReviewed, bankStaleReason: null },
    select: { id: true, bankReviewed: true, bankStaleReason: true },
  });
  return Response.json({
    conceptId: updated.id,
    bankReviewed: updated.bankReviewed,
    bankStaleReason: updated.bankStaleReason,
  });
});
