#!/usr/bin/env bash
#
# Free-beta E2: the one way the curation skills reach an admin route.
#
#   scripts/operator-curl.sh /api/playground/pending-resources?limit=5
#   scripts/operator-curl.sh /api/playground/resources -XPATCH \
#     -H 'content-type: application/json' -d '{"resourceId":"…","fields":{…}}'
#
# It exists for three reasons, in order of importance:
#
#   1. FAIL CLOSED ON THE TARGET. E1's hazard was that `curl localhost:3000/…`
#      looks identical whichever database is behind it. Here the target is never
#      implicit and never defaulted: no OPERATOR_BASE_URL, no request. Every run
#      prints where it went, so the answer is in the transcript rather than in
#      whatever the operator remembers about how the server was started.
#   2. THE TOKEN NEVER BECOMES A SHELL WORD. Per AGENTS.md, both of this repo's
#      real leaks came from a command that printed a secret as a side effect of
#      failing, not from anyone echoing one. So the token is read from the env
#      file straight into a curl config on a pipe — never assigned to a
#      variable, never exported, never in argv (where `ps` and shell history
#      would see it). Only its byte count is ever computed.
#   3. One edit point. The four HTTP skills call this instead of embedding a
#      base URL, so re-pointing them is a config change, not eight file edits.
#
# Local development still works with no token at all: against a localhost base
# URL the request goes out unauthenticated and DEV_AUTH covers it. Off localhost
# a missing token is an error, not a fallback.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_FILE="${OPERATOR_ENV_FILE:-$REPO_ROOT/.env.local}"
readonly MIN_TOKEN_BYTES=32

die() { printf '\n✗ [operator-curl] %s\n\n' "$1" >&2; exit 2; }

# Reads one KEY=value out of the env file to stdout, unquoted, without a
# trailing newline. Never assigned to a variable — see (2) above. Silent when
# the key is absent; callers decide whether that is fatal.
read_env_value() {
  grep -m1 -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null \
    | sed -E "s/^[[:space:]]*$1=//; s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/" \
    | tr -d '\n' \
    || true
}

[ $# -ge 1 ] || die "usage: operator-curl.sh <path> [curl args...]

<path> is an absolute API path, e.g. /api/playground/pending-resources?limit=5"

path="$1"; shift
case "$path" in
  /*) ;;
  *) die "path must start with '/' — got '$path'. The base URL comes from
  OPERATOR_BASE_URL; passing a full URL here would defeat that." ;;
esac

# The base URL is not a secret, so a variable is fine; the token below is not.
base="${OPERATOR_BASE_URL:-}"
if [ -z "$base" ]; then
  [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist, and OPERATOR_BASE_URL is unset.
  There is deliberately no default: see docs/operator-tooling.md."
  base="$(read_env_value OPERATOR_BASE_URL)"
fi
[ -n "$base" ] || die "OPERATOR_BASE_URL is not set (checked the shell, then $ENV_FILE).

  Set it to the service you mean to operate — there is no default, because a
  silent fallback to localhost is exactly the failure this script prevents:
    OPERATOR_BASE_URL=https://learning-app-sau6bxtxta-uw.a.run.app   (production)
    OPERATOR_BASE_URL=http://localhost:3000                          (local dev)"

base="${base%/}"
case "$base" in
  http://*|https://*) ;;
  *) die "OPERATOR_BASE_URL must include a scheme — got '$base'." ;;
esac

host="${base#*://}"; host="${host%%/*}"; host="${host%%:*}"
is_local=no
case "$host" in
  localhost|127.0.0.1|'[::1]'|::1) is_local=yes ;;
esac

token_bytes=0
if [ -f "$ENV_FILE" ]; then
  token_bytes="$(read_env_value OPERATOR_ADMIN_TOKEN | wc -c | tr -d '[:space:]')"
fi

if [ "$token_bytes" -eq 0 ]; then
  [ "$is_local" = yes ] || die "OPERATOR_ADMIN_TOKEN is not set in $ENV_FILE.

  $base is not localhost, so there is no dev bypass to fall back on and the
  request would 404. Generate a token and provision it per docs/operator-tooling.md."
elif [ "$token_bytes" -lt "$MIN_TOKEN_BYTES" ]; then
  # Matches MIN_TOKEN_BYTES in src/lib/api/operator-token.ts, which rejects the
  # same value server-side. Caught here so the failure names the cause instead
  # of arriving as an unexplained 404.
  die "OPERATOR_ADMIN_TOKEN in $ENV_FILE is $token_bytes bytes; the server
  requires at least $MIN_TOKEN_BYTES and will reject it. Regenerate it:
    openssl rand -base64 32"
fi

method=GET
for arg in "$@"; do
  case "$arg" in
    -X*) [ "$arg" = "-X" ] || method="${arg#-X}" ;;
  esac
done

printf '[operator-curl] %s %s%s%s\n' \
  "$method" "$base" "$path" "$([ "$is_local" = yes ] || printf '  ⚠ REMOTE')" >&2

if [ "$token_bytes" -eq 0 ]; then
  exec curl "$base$path" "$@"
fi

# -K reads a curl config; the process substitution keeps the token off argv and
# off disk, and leaves stdin free for callers using `-d @-`. The value is base64
# (openssl rand -base64), so it contains nothing curl's quoted form escapes.
exec curl -K <(
  printf 'header = "authorization: Bearer '
  read_env_value OPERATOR_ADMIN_TOKEN
  printf '"\n'
) "$base$path" "$@"
