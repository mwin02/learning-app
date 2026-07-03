// Phase 3e: barebones landing — an integration-test surface for the auth + program
// flow, NOT the designed 2.6a landing page (that comes with the frontend pass).
// Anonymous: sign-in link. Signed in: identity, links to My Programs / Create.

import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getViewer } from '@/lib/auth/viewer';

export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>;
}) {
  const [{ auth_error }, viewer] = await Promise.all([searchParams, getViewer()]);
  const user = viewer.userId
    ? await prisma.user.findUnique({
        where: { id: viewer.userId },
        select: { email: true, name: true },
      })
    : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface text-ink">
      <main className="card w-full max-w-md p-8">
        <div className="eyebrow mb-2">Adaptive Learning Path</div>
        <h1 className="mb-4 text-2xl font-bold tracking-[-0.5px]">
          A learning plan that gets you to your goal
        </h1>

        {auth_error && (
          <p className="mb-4 rounded-control bg-fill px-3 py-2 text-sm text-red-600">
            Sign-in failed. Please try again.
          </p>
        )}

        {viewer.userId ? (
          <div className="flex flex-col gap-3">
            <p className="meta">
              Signed in as {user?.name ?? user?.email ?? viewer.userId}
              {viewer.isAdmin ? ' (admin)' : ''}
            </p>
            <Link
              href="/programs/new"
              className="rounded-button bg-brand px-5 py-2.5 text-center font-semibold text-white"
            >
              Create a program
            </Link>
            <Link
              href="/programs"
              className="rounded-button border border-line px-5 py-2.5 text-center font-semibold"
            >
              My programs
            </Link>
            {viewer.isAdmin && (
              <Link href="/playground" className="meta-xs text-center underline">
                Playground
              </Link>
            )}
            <form method="post" action="/auth/signout">
              <button type="submit" className="meta-xs w-full text-center underline">
                Sign out
              </button>
            </form>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-body">
              Tell us your goal; we build a personalized, sequenced program of real
              resources to get you there.
            </p>
            <a
              href="/auth/login"
              className="rounded-button bg-brand px-5 py-2.5 text-center font-semibold text-white"
            >
              Continue with Google
            </a>
            {viewer.isAdmin && (
              <Link href="/playground" className="meta-xs text-center underline">
                Playground (dev bypass)
              </Link>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
