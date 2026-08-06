'use client';

// Free-beta B1: the app-wide error boundary. Every uncaught render error below
// the root layout bubbles here, so this is the fallback users actually see;
// global-error.tsx only takes over when the root layout itself fails.
//
// What it reports is narrower than it looks. In production Next replaces a
// Server Component's error with a generic message plus `digest` before it
// reaches this component, so for server errors the useful record is the
// `server.unhandled` line instrumentation.ts already wrote — the digest sent
// here is what pairs the two. For genuine client-side crashes, this is the only
// record there will ever be.

import { useEffect } from 'react';
import { reportClientError } from '@/lib/client-error-report';

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    reportClientError({ message: error.message, stack: error.stack, digest: error.digest });
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="card max-w-md text-center">
        <p className="eyebrow">Error</p>
        <h1 className="font-hand text-2xl text-ink">Something went wrong</h1>
        <p className="mt-2 text-sm text-body">
          This one is on us — the problem has been reported. Trying again often works.
        </p>
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="mt-6 rounded-button bg-brand px-4 py-2 text-sm font-medium text-on-accent"
        >
          Try again
        </button>
        {error.digest ? <p className="meta-xs mt-4">Reference {error.digest}</p> : null}
      </div>
    </main>
  );
}
