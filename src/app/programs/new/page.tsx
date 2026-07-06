// Phase 3e: barebones "create a program" form — the structured stand-in for the
// future chat intake agent, which will construct the SAME payload and hit the
// same endpoint. Static route, so it wins over /programs/[programId].

import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { NewProgramForm } from '../_components/NewProgramForm';

export const dynamic = 'force-dynamic';

export default async function NewProgramPage() {
  const viewer = await getViewer();
  if (!viewer.userId) redirect('/signin?next=%2Fprograms%2Fnew');
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-6 text-ink">
      <main className="card w-full max-w-lg p-8">
        <div className="eyebrow mb-2">New program</div>
        <h1 className="mb-4 text-2xl font-bold tracking-[-0.5px]">What's your goal?</h1>
        <NewProgramForm />
      </main>
    </div>
  );
}
