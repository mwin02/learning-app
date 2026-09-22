// The decision half of AuthStateSync, kept pure so it can be unit-tested — the
// component around it is subscription glue with no logic of its own.
//
// `actedOn` is the browser-session presence we last refreshed for. It exists to
// stop a refresh storm in the one case where the two sides can disagree
// permanently: a browser session the server rejects (a revoked or otherwise
// unusable token the client hasn't discovered yet). There, refreshing never
// changes `serverSignedIn`, so we act once per distinct browser state and then
// wait for that state to actually move.

export type AuthSyncDecision = {
  refresh: boolean;
  actedOn: boolean | null;
};

export function decideAuthSync(
  actedOn: boolean | null,
  serverSignedIn: boolean,
  browserSignedIn: boolean
): AuthSyncDecision {
  // Agreement is the steady state: re-arm so a later divergence is acted on.
  if (browserSignedIn === serverSignedIn) return { refresh: false, actedOn: null };
  if (actedOn === browserSignedIn) return { refresh: false, actedOn };
  return { refresh: true, actedOn: browserSignedIn };
}
