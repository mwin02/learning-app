'use client';

// Free-beta B1: last-resort boundary. It replaces the root layout, so it must
// render its own <html>/<body> and cannot use anything the layout provides —
// no TopNav, and no fonts, since next/font's CSS variables are set on the <html>
// this component is substituting for. Hence the plain, token-only styling: the
// point is that this page cannot itself fail.
//
// Reached only when the root layout throws; everything below it lands in
// error.tsx instead.

import { useEffect } from 'react';
import { reportClientError } from '@/lib/client-error-report';

export default function GlobalError({
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
    <html lang="en">
      <body className="bg-surface text-body">
        <main className="flex min-h-screen items-center justify-center px-6 text-center">
          <div>
            <h1 className="text-2xl text-ink">Something went wrong</h1>
            <p className="mt-2 text-sm">The problem has been reported.</p>
            <button
              type="button"
              onClick={() => unstable_retry()}
              className="mt-6 rounded-button bg-brand px-4 py-2 text-sm font-medium text-white"
            >
              Try again
            </button>
            {error.digest ? <p className="mt-4 text-xs text-muted">Reference {error.digest}</p> : null}
          </div>
        </main>
      </body>
    </html>
  );
}
