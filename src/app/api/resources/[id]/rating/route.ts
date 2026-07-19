// Free-beta A2: cast/clear the viewer's vote on a resource.
//
//   POST { value: 1 | -1 | null }   — upsert (±1) or clear (null) the viewer's
//                                     ResourceRating row, then recompute the
//                                     resource's trustScore through the A1 seam.
//
// Requires a REAL session — the dev bypass's null userId gets a clean 401, like
// progress (a vote needs an owner). Unknown resource id → non-enumerable 404.
// No aggregate counts in the response (locked: plain toggles for beta — no
// herding); the viewer's own vote hydrates server-side via loadViewerVotes.
// Recompute runs sync in the request: it's two small queries + one update. Its
// return value feeds A4's eviction check (evict-low-trust.ts) right after.

import { z, ZodError } from 'zod';
import { withAuth } from '@/lib/api/with-auth';
import { prisma } from '@/lib/db';
import { recomputeResourceTrust } from '@/lib/curation/recompute-trust';
import { maybeEvictLowTrust } from '@/lib/curation/evict-low-trust';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ value: z.union([z.literal(1), z.literal(-1), z.null()]) });

export const POST = withAuth<Ctx>(async (req, session, ctx) => {
  if (!session.userId) {
    return Response.json(
      { error: 'Rating requires a signed-in user.', code: 'UNAUTHENTICATED' },
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

  const { id: resourceId } = await ctx.params;
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true },
  });
  if (!resource) {
    return Response.json({ error: 'Resource not found.', code: 'NOT_FOUND' }, { status: 404 });
  }

  if (body.value === null) {
    // deleteMany: clearing an already-absent vote is a no-op, not an error.
    await prisma.resourceRating.deleteMany({
      where: { userId: session.userId, resourceId },
    });
  } else {
    await prisma.resourceRating.upsert({
      where: { userId_resourceId: { userId: session.userId, resourceId } },
      update: { value: body.value },
      create: { userId: session.userId, resourceId, value: body.value },
    });
  }

  const recomputed = await recomputeResourceTrust(resourceId);
  // A4: sustained negative consensus evicts (soft reject → link cleanup +
  // readiness recompute). Sync — rare by construction, one transaction. The
  // voter's response doesn't change either way (no aggregate leakage).
  if (recomputed) await maybeEvictLowTrust(resourceId, recomputed);
  return Response.json({ ok: true, value: body.value });
});
