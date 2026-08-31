// One-time setup for the landing-page demo recording: capture the DEMO
// account's session, which scripts/demo-record.ts then replays. Sign-in is
// Google OAuth, which cannot be automated (and must not be — the password is
// yours to type), so this hands you a real browser window.
//
//   npx tsx scripts/demo-auth.ts --url https://<cloud-run-host>
//   npx tsx scripts/demo-auth.ts --port 9223        # if 9222 is taken
//
// Sessions are per-origin: a session captured against one Cloud Run hostname is
// NOT valid on the other, nor on localhost. Use the same --url here and in
// demo-record.ts.
//
// Chrome is launched as an ordinary process — no automation switches, nothing
// for Google's "this browser or app may not be secure" check to object to —
// with only a debugging port opened so this script can read the session back
// out of the LIVE browser. Reading it live is the point: the earlier version
// read the profile off disk after you quit Chrome, which is where it broke.
// Chrome keeps cookies in memory and writes them lazily, and a cookie with no
// explicit expiry is a session cookie that is DISCARDED on quit — so "sign in,
// quit, then look at the files" can find nothing even though sign-in worked.
//
// The captured session is written to .demo-auth.json (git-ignored). That file
// is a live credential: it is not printed, not logged, and never read back into
// a conversation. Delete it when the recording is done.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { AUTH_STATE, PROFILE_DIR, appUrl, numArg } from './demo-config';

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(question);
  rl.close();
}

function launchChrome(url: string, port: number) {
  if (!existsSync(CHROME_MAC)) {
    throw new Error(`Chrome not found at ${CHROME_MAC}.`);
  }
  const child = spawn(
    CHROME_MAC,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      `${url}/signin`,
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
}

async function main() {
  const url = appUrl(process.argv);
  const port = numArg('port', 9222);
  const host = new URL(url).hostname;

  rmSync(PROFILE_DIR, { recursive: true, force: true });
  console.log(`capturing a demo session for ${url}`);
  launchChrome(url, port);

  console.log('\nA normal Chrome window is opening — a separate instance on a throwaway');
  console.log('profile, so your everyday Chrome and its logins are untouched.');
  console.log(`\n  1. Sign in at ${url}/signin with the DEMO account.`);
  console.log('  2. Wait until you can see your notebook (the signed-in home page).');
  console.log('  3. LEAVE THAT WINDOW OPEN — do not quit it this time.');
  await ask('\nPress Enter here once you are signed in and can see the app… ');

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome exposed no browser context — was the window closed?');

  const cookies = (await context.cookies()).filter((c) => c.domain.replace(/^\./, '') === host);
  await browser.close();

  // Names and lifetimes only — never values. A "session" lifetime here is
  // exactly the failure mode described above, so it is worth seeing.
  console.log('\ncookies captured for', host);
  for (const c of cookies) {
    const life = c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session (no expiry)';
    console.log(`  ${c.name}  ·  ${life}${c.httpOnly ? '  · httpOnly' : ''}`);
  }

  const authed = cookies.some((c) => c.name.startsWith('sb-') && c.name.includes('auth-token'));
  if (!authed) {
    console.error('\nNo Supabase auth cookie found. Sign-in did not complete, or it completed');
    console.error('on a different hostname than the one passed to --url. Check the address bar');
    console.error(`in that Chrome window — it must be ${host}.`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(AUTH_STATE, JSON.stringify({ cookies, origins: [] }, null, 2), { mode: 0o600 });
  console.log(`\nSession saved to ${AUTH_STATE} (git-ignored, mode 600).`);
  console.log('You can close that Chrome window now.');
  console.log(`Next: npx tsx scripts/demo-record.ts --url ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
