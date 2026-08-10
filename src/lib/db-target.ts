// The one-line description of which database a process is talking to, shared by
// everything that announces its target: the Prisma singleton (@/lib/db), the ops
// guard (scripts/target-guard.ts), and — in the same shape, by hand, because
// they are CommonJS — the two skill helpers `pending-review-db.cjs` and
// `decomp-db.cjs`.
//
// Free-beta E1: the operator pattern is a LOCAL app against the PRODUCTION
// database (operator-tooling.md), so the same `curl localhost:3000/…` a
// review skill runs edits either the throwaway Docker library or the live one,
// with nothing in the command to tell them apart. One recognisable string,
// formatted identically wherever it is printed, is what makes the target
// checkable at a glance.

// Kept out of @/lib/db so importing it costs nothing: db.ts builds a Prisma
// client at module eval, which a script (or a unit test) that only wants the
// label has no reason to pay for.

/**
 * `host:port/dbname` for a Postgres connection string — never the credentials,
 * since this is printed into logs that are shipped off the machine.
 */
export function describeDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}
