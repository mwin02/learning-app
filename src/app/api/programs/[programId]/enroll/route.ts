// Phase 3c: POST /api/programs/[programId]/enroll — enroll the signed-in user
// in an EXISTING Program. Free and unlimited by design (creation is the metered
// action — the spend already happened when the Program was built); enrolling
// grants read access to the program page + its tracks (gated in 3d). Idempotent:
// re-enrolling is a no-op success.

import { withAuth } from '@/lib/api/with-auth';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ programId: string }> };

export const POST = withAuth<Ctx>(async (_req, session, ctx) => {
  // Enrollment is a per-user row — unlike generation, it can't tolerate the dev
  // bypass's null userId. A real session is required even in dev.
  if (!session.userId) {
    return Response.json(
      { error: 'Enrolling requires a signed-in user.', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }

  const { programId } = await ctx.params;
  const program = await prisma.program.findUnique({
    where: { id: programId },
    select: { id: true, status: true },
  });
  if (!program) {
    return Response.json({ error: 'Program not found.', code: 'NOT_FOUND' }, { status: 404 });
  }
  if (program.status === 'failed') {
    // Nothing to take: a failed Program has no plan slots worth walking.
    return Response.json(
      { error: 'This program failed to build and cannot be enrolled in.', code: 'PROGRAM_FAILED' },
      { status: 409 }
    );
  }

  await prisma.enrolledProgram.upsert({
    where: { userId_programId: { userId: session.userId, programId } },
    create: { userId: session.userId, programId },
    update: {},
  });

  return Response.json({ enrolled: true, programId });
});
