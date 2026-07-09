// Chat intake Block 4: the chat is now the default create-a-program surface;
// the 3e structured form stays behind a "prefer a form?" toggle as the
// turn-budget fallback and escape hatch. Both construct the SAME payload and
// hit the same endpoint (shared submitProgram helper). Static route, so it
// wins over /programs/[programId]. ?goal=… (the home scratchpad's
// carry-through, sign-in-redirect-preserving) seeds the chat's first message.

import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { IntakePane } from '../_components/IntakeChat';

export const dynamic = 'force-dynamic';

export default async function NewProgramPage({
  searchParams,
}: {
  searchParams: Promise<{ goal?: string }>;
}) {
  const [{ goal }, viewer] = await Promise.all([searchParams, getViewer()]);
  if (!viewer.userId) {
    const next = goal ? `/programs/new?goal=${encodeURIComponent(goal)}` : '/programs/new';
    redirect(`/signin?next=${encodeURIComponent(next)}`);
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-6 text-ink">
      <main className="card w-full max-w-lg p-8">
        <div className="eyebrow mb-2">New program</div>
        <h1 className="mb-4 text-2xl font-bold tracking-[-0.5px]">What&apos;s your goal?</h1>
        <IntakePane initialGoal={goal} />
      </main>
    </div>
  );
}
