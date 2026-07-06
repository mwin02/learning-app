'use client';

// Phase 3d: the one interactive bit of the enrollment stub. POSTs the (free,
// idempotent) enroll endpoint, then refreshes the route so the layout re-renders
// as the enrolled hub.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

// Anonymous variant of the CTA: into sign-in and back to the CURRENT path —
// a deep course/lesson link shows the prompt at its own URL, and an already-
// enrolled user signing in from it lands exactly where the link pointed.
export function SignInToEnrollLink() {
  const pathname = usePathname();
  return (
    <Link
      href={`/signin?next=${encodeURIComponent(pathname)}`}
      className="btn-ink block px-4 py-1.5 text-[22px] no-underline"
    >
      Sign in to enroll →
    </Link>
  );
}

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
        className="btn-ink w-full px-4 py-1.5 text-[24px] disabled:opacity-50"
      >
        {state === 'busy' ? 'Enrolling…' : 'Enroll now'}
      </button>
      {state === 'error' && (
        <p className="mt-2 font-script text-xs text-crayon-red">Could not enroll — try again.</p>
      )}
    </div>
  );
}
