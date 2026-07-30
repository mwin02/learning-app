// Zod schema for POST /api/client-error (free-beta B1).
//
// Every field is attacker-controlled — the endpoint is unauthenticated by
// necessity — so the caps are the point, not the shape. They bound what a
// single accepted report can add to paid log ingestion; CLIENT_ERROR_MAX_BYTES
// bounds the request before it ever gets here.
//
// `stack` gets the largest budget because it is the only field that earns
// anything: Error Reporting groups on stack frames, and a browser stack with
// bundled chunk URLs is long. `digest` is Next's server-error identifier,
// forwarded so a client report pairs with the `server.unhandled` line that
// instrumentation.ts already logged for the same failure.

import { z } from 'zod';

export const clientErrorSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  stack: z.string().trim().max(6000).optional(),
  url: z.string().trim().max(2000).optional(),
  digest: z.string().trim().max(200).optional(),
});

export type ClientErrorInput = z.infer<typeof clientErrorSchema>;
