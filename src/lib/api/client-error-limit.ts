// Free-beta B1: the rate limit on /api/client-error.
//
// Why a plain per-instance token bucket rather than the per-user DB counting that
// program-limits/rating-limits do:
//
//   - There is no user. The endpoint has to accept reports from anonymous
//     visitors, so there is no key to count rows against.
//   - A DB write is the wrong dependency for this endpoint specifically. It is
//     the one route whose job is to work while the app is broken, and a Postgres
//     round trip on the failure path is exactly what will also be failing.
//   - The service runs min-instances 0 / max 4, so this state is per-instance and
//     evaporates between cold starts. That is accepted: what this bounds is paid
//     log ingestion from a loop or a script, and a bucket per instance caps that
//     at (instances × rate) — a small constant, which is the whole requirement.
//     Fairness between clients is not a goal; there are no users to be fair to.
//
// One global bucket, not one per IP: a keyed map on an unauthenticated endpoint
// is itself a memory-growth vector and needs eviction logic to be safe. The
// blast radius of the simple version is that a flood of reports from one client
// can crowd out another's — acceptable when the alternative it protects is the
// log bill, and when Error Reporting dedupes identical groups anyway.

export type TokenBucket = {
  /** Consume one token. False when the bucket is empty (caller should 429). */
  tryConsume: (now?: number) => boolean;
};

/**
 * A token bucket holding `capacity` tokens, regaining one every `refillMs`.
 * Pure apart from the default clock — pass `now` to test it deterministically.
 */
export function createTokenBucket(capacity: number, refillMs: number, start: number = Date.now()): TokenBucket {
  let tokens = capacity;
  let last = start;
  return {
    tryConsume(now: number = Date.now()): boolean {
      const elapsed = now - last;
      if (elapsed >= refillMs) {
        const gained = Math.floor(elapsed / refillMs);
        tokens = Math.min(capacity, tokens + gained);
        // Advance by whole refill periods only, so a sub-period remainder still
        // counts toward the next token instead of being rounded away.
        last += gained * refillMs;
      }
      if (tokens <= 0) return false;
      tokens -= 1;
      return true;
    },
  };
}
