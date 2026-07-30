// Free-beta B1: the client half of error reporting. A browser-side crash never
// touches the server, so it can only reach Cloud Logging if the browser tells
// us — global-error.tsx POSTs here and this logError puts it in the same stream
// (and therefore the same Error Reporting groups) as every server error.
//
// NOT wrapped in withAuth, deliberately: a crash on the sign-in page or during
// hydration happens to visitors with no session, and those are the crashes most
// worth knowing about. The origin check is kept — it is the CSRF wrapper's other
// half, and here it does real work, refusing off-site scripts that would use
// this endpoint to write to our logs at our expense.
//
// runtime 'nodejs' because log.ts uses AsyncLocalStorage.

import { requireSameOrigin } from '@/lib/api/origin-check';
import { clientErrorSchema } from '@/lib/api/client-error-schema';
import { createTokenBucket } from '@/lib/api/client-error-limit';
import { CLIENT_ERROR_BURST, CLIENT_ERROR_MAX_BYTES, CLIENT_ERROR_REFILL_MS } from '@/lib/config';
import { logError, logWarn } from '@/lib/log';

export const runtime = 'nodejs';

const bucket = createTokenBucket(CLIENT_ERROR_BURST, CLIENT_ERROR_REFILL_MS);

export async function POST(req: Request): Promise<Response> {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  if (!bucket.tryConsume()) {
    // Warn, not error: being rate-limited is this endpoint working. Logging it
    // at ERROR would create an Error Reporting group for our own throttle and
    // page on it — the exact loop the limit exists to prevent.
    logWarn('client.error.throttled', { path: new URL(req.url).pathname });
    return new Response(null, { status: 429 });
  }

  // Reject on the declared length first — the cheap check — then on the actual
  // body, since Content-Length can lie or be absent under chunked encoding.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > CLIENT_ERROR_MAX_BYTES) return new Response(null, { status: 413 });
  const raw = await req.text();
  if (raw.length > CLIENT_ERROR_MAX_BYTES) return new Response(null, { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Malformed JSON.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const parsed = clientErrorSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid error report.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const { message, stack, url, digest } = parsed.data;
  // Shaped as { name, message, stack } so log.ts's firstStack finds the browser
  // stack and lifts it into the line's `message` — which is what makes this
  // group in Error Reporting instead of landing as an unattributed text error.
  logError('client.unhandled', {
    report: { name: 'ClientError', message, ...(stack ? { stack } : {}) },
    url,
    digest,
  });

  // 204: the client is already showing an error screen and has nothing to do
  // with a response body.
  return new Response(null, { status: 204 });
}
