// Mirror of the env check in src/lib/api/with-auth.ts so server pages can
// guard themselves the same way wrapped routes do. Phase 3 replaces both
// call sites with a real Supabase session check.

export function isDevAuthEnabled(): boolean {
  return process.env.DEV_AUTH === '1';
}
