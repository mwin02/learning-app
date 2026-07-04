// Page-side guard for the internal playground. 3b swapped the API wrappers
// (with-auth / with-admin-auth) to real Supabase sessions; the playground PAGES
// still gate on this until 3d replaces it with a real session + role check.
// Mirrors the wrappers' dev bypass: dev-only, so a deployed env with a stray
// DEV_AUTH=1 no longer exposes the playground.

export function isDevAuthEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.DEV_AUTH === '1';
}
