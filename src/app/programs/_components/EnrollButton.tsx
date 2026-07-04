'use client';

// Phase 3d: the one interactive bit of the enrollment stub. POSTs the (free,
// idempotent) enroll endpoint, then refreshes the route so the layout re-renders
// as the enrolled hub.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function EnrollButton({ programId }: { programId: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');

  async function enroll() {
    setState('busy');
    const res = await fetch(`/api/programs/${programId}/enroll`, { method: 'POST' });
    if (res.ok) router.refresh();
    else setState('error');
  }

  return (
    <div>
      <button
        type="button"
        onClick={enroll}
        disabled={state === 'busy'}
        className="rounded-button bg-brand px-6 py-2.5 font-semibold text-white disabled:opacity-50"
      >
        {state === 'busy' ? 'Enrolling…' : 'Enroll — free'}
      </button>
      {state === 'error' && (
        <p className="meta-xs mt-3 text-red-600">Could not enroll. Try again.</p>
      )}
    </div>
  );
}
