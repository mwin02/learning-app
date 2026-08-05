// Free-beta E2: the POST half of the decompose skill, for the routes that build
// their payload in Node rather than in a shell (node-toc, anchor-toc,
// video-chapters). Those are ad-hoc scratchpad scripts run as plain
// `node <script>.cjs <resourceId>` with no --env-file, so they cannot read
// .env.local themselves and cannot use scripts/operator-curl.sh either.
//
// Requiring this instead of inlining a fetch keeps three properties the shell
// wrapper has, in the place where they are easiest to lose:
//   - the base URL is never defaulted to localhost (fail closed on the target);
//   - the admin credential comes from the env file, not from a literal pasted
//     into a scratchpad script that gets read back later;
//   - every call announces where it went.
//
//   const { postDecompositionReview } = require(
//     '<repo>/.claude/skills/decompose/scripts/operator-post.cjs');
//   const res = await postDecompositionReview({ resourceId, action: 'decompose_manual', children });

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ENV_FILE = process.env.OPERATOR_ENV_FILE || path.join(REPO_ROOT, '.env.local');
// Mirrors MIN_TOKEN_BYTES in src/lib/api/operator-token.ts, so a placeholder
// value fails here with a cause instead of arriving as an unexplained 404.
const MIN_TOKEN_BYTES = 32;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function readEnvValue(key) {
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    return undefined;
  }
  const match = new RegExp(`^[ \\t]*${key}=(.*)$`, 'm').exec(text);
  if (!match) return undefined;
  return match[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function resolveConfig() {
  const base = (process.env.OPERATOR_BASE_URL || readEnvValue('OPERATOR_BASE_URL') || '').replace(/\/$/, '');
  if (!base) {
    throw new Error(
      `OPERATOR_BASE_URL is not set (checked the shell, then ${ENV_FILE}). ` +
        'There is deliberately no default — see docs/operator-tooling.md.'
    );
  }
  let host;
  try {
    host = new URL(base).hostname;
  } catch {
    throw new Error(`OPERATOR_BASE_URL is not a valid URL: ${base}`);
  }
  const isLocal = LOCAL_HOSTS.has(host);

  const token = readEnvValue('OPERATOR_ADMIN_TOKEN');
  if (!token) {
    if (!isLocal) {
      throw new Error(
        `OPERATOR_ADMIN_TOKEN is not set in ${ENV_FILE}, and ${base} is not localhost — ` +
          'there is no dev bypass to fall back on and the request would 404. ' +
          'See docs/operator-tooling.md.'
      );
    }
    return { base, isLocal, token: null };
  }
  if (Buffer.byteLength(token, 'utf8') < MIN_TOKEN_BYTES) {
    throw new Error(
      `OPERATOR_ADMIN_TOKEN in ${ENV_FILE} is shorter than the ${MIN_TOKEN_BYTES} bytes the ` +
        'server requires and will be rejected. Regenerate it: openssl rand -base64 32'
    );
  }
  return { base, isLocal, token };
}

/**
 * POSTs to /api/playground/decomposition-review with the operator credential.
 * Resolves to `{ status, body }` — the caller decides what a non-200 means.
 *
 * The 300s timeout is the payload's, not the network's: `decompose_manual`
 * derives concepts and embeds every child server-side, which runs into minutes
 * for a 200-lesson course.
 */
async function postDecompositionReview(payload, { timeoutMs = 300000 } = {}) {
  const { base, isLocal, token } = resolveConfig();
  const url = `${base}/api/playground/decomposition-review`;
  console.error(`[operator-post] POST ${url}${isLocal ? '' : '  ⚠ REMOTE'}`);

  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

module.exports = { postDecompositionReview, resolveConfig };
