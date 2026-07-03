// Phase 3b: post-auth redirect targets come from a query param, so they're
// attacker-suppliable. Only same-origin relative paths pass; anything absolute
// or protocol-relative ("//evil.com") falls back to home.

export function safeNextPath(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}
