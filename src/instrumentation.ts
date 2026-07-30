// Free-beta B1: the server half of error reporting. Next calls onRequestError
// for every error the server captures — Server Component renders, route
// handlers, Server Actions — so this is the one seam that sees an unhandled
// throw anywhere in the app without a try/catch at the site.
//
// It exists because the client error boundary CANNOT do this job: in production
// Next replaces a Server Component's error with a generic message plus a digest
// before it reaches error.tsx, so a boundary reporting what it was handed sends
// no stack and nothing groups. Here the error is the real one. The digest is
// logged on both sides, so a user-reported "error id" pairs with this line.
//
// Deliberately never throws: an error in the error reporter would replace the
// real failure with a less useful one.

import type { Instrumentation } from 'next';
import { logError } from '@/lib/log';

export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  try {
    const error = err as Error & { digest?: string };
    logError('server.unhandled', {
      err: error,
      digest: error.digest,
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    });
  } catch {
    // Nothing useful left to do — the logger itself failed. Swallowing keeps
    // Next's own error handling on the original error.
  }
};
