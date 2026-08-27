// The contact channel. Deliberately a mailto: for now — a real SupportRequest
// table + triage surface is the eventual shape (it would mirror ResourceReport),
// but the error pages need *a* way to reach us before that exists, and a mailto
// works for signed-out visitors, which the report stack does not.
//
// Kept as a lib module rather than inlined in the pages so the address is one
// edit away from becoming a route, and so the body-building is unit-testable.

export const SUPPORT_EMAIL = 'support@coursehub.app';

/**
 * A mailto: URL with subject and body percent-encoded.
 *
 * encodeURIComponent, not encodeURI: the body carries newlines and `&`, both of
 * which encodeURI leaves intact and which would then terminate or split the
 * query — the classic mailto truncation bug.
 */
export function supportMailto({ subject, body }: { subject: string; body?: string }): string {
  const query = [`subject=${encodeURIComponent(subject)}`];
  if (body) query.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${SUPPORT_EMAIL}?${query.join('&')}`;
}
