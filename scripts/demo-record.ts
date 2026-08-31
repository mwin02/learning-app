// Records the landing-page product demo: one scripted pass through the real
// app, captured as video by Playwright. Re-run it after a UI change instead of
// re-recording by hand — that repeatability is the whole reason this is a
// script and not a screen capture.
//
//   npx tsx scripts/demo-record.ts --part head --url https://<host>
//   npx tsx scripts/demo-record.ts --part tail --program <id> [--lesson <id>] --url https://<host>
//
// The demo is shot as two takes and joined by demo-encode.ts:
//
//   head — landing, writing the goal, the intake conversation, and the click on
//          "Create program". Cuts on the "Planning your program…" beat.
//   tail — a tour of a program that is already built: overview, a course, a
//          lesson, the self-check reveal, progress landing on the notebook.
//
// --lesson picks WHICH lesson to open, rather than following the course's
// "pick up where you left off" card. On a fresh program that card points at
// lesson 1, which is the one lesson with no exercises — so the self-check, the
// best beat in the tail, would not exist. Pass a lesson that has questions.
//
// Splitting them is what makes this affordable. Course writing runs on the
// worker VM and takes far longer than the plan step, so a single continuous
// take would spend most of its runtime filming a spinner. The head take creates
// the program; you record the tail against it once the worker has finished.
//
// Requires a captured session for that SAME origin: run scripts/demo-auth.ts
// with the matching --url first (sessions are per-origin — a session captured
// against one host is not valid on another).
//
// Recording against prod is the intended default: prod has the fuller resource
// library, so the generated tracks are better. Three consequences — the run
// bills real Vertex calls, leaves a real Program row on the demo account, and
// waits longer, because course building goes through the worker VM.
//
// A head take spends one of FREE_PROGRAMS_PER_MONTH (3); pass --no-create to
// stop just before the click and spend none. Tail takes are always free, so
// iterate on the second half as much as you like.
//
// Nothing here is faked: both takes drive the real app against real data. The
// only thing the edit hides is the wait between them.

import { chromium, type Page, type Locator } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_STATE, OUT_DIR, VIEWPORT, DEVICE_SCALE_FACTOR, appUrl } from './demo-config';

const GOAL = "I want to be ready for a Master's in AI";

// The intake is a chat with a live model, so its questions vary run to run.
// These are deliberately generic answers to the things it reliably asks about
// (background, time budget, deadline); they are consumed in order, and the loop
// stops as soon as the confirmation card appears.
const REPLIES = [
  "I studied computer science at university, but that was a few years ago and I'm rusty on the maths.",
  'About 4 hours a week.',
  "I'd like to be ready in around 3 months.",
  'That looks right.',
];

const marks: { label: string; tMs: number }[] = [];
let t0 = 0;
const mark = (label: string) => {
  marks.push({ label, tMs: Date.now() - t0 });
  console.log(`  mark ${label} @ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};

const beat = (page: Page, ms: number) => page.waitForTimeout(ms);

// Playwright's mouse is invisible and jumps straight to its target, which reads
// as a page glitching rather than a person clicking. This draws a cursor that
// follows the real mousemove events Playwright dispatches, plus a click ripple.
const CURSOR_SCRIPT = `(() => {
  if (window.__demoCursor) return;
  window.__demoCursor = true;
  const install = () => {
    const cur = document.createElement('div');
    // left/top MUST be 0: the transform below composes with them, so any offset
    // here is added to every pointer position and the arrow is drawn away from
    // the real cursor. Park it off-screen via the transform instead.
    cur.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);will-change:transform';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 3l14 8-6 1.6L10.6 19z" fill="#fff" stroke="rgba(0,0,0,.55)" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cur);
    addEventListener('mousemove', (e) => {
      cur.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
    }, { passive: true, capture: true });
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + (e.clientX - 6) + 'px;top:' + (e.clientY - 6) + 'px;width:12px;height:12px;border-radius:50%;background:rgba(120,170,255,.55);z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(4)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, { passive: true, capture: true });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install);
  else install();
})();`;

// Move in interpolated steps so the drawn cursor travels instead of teleporting,
// then pause on the target before pressing — the beat that makes a click read as
// deliberate rather than instant.
async function humanClick(page: Page, target: Locator, { settle = 350 } = {}) {
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const box = await target.boundingBox();
  if (!box) throw new Error('target has no bounding box — is it visible?');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
  await page.waitForTimeout(settle);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

// Wheel scrolling in small increments: one big jump produces a single-frame cut
// in the video, which looks like a splice rather than a scroll.
async function glideScroll(page: Page, distance: number, steps = 26) {
  const per = distance / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, per);
    await page.waitForTimeout(26);
  }
}

// Never `networkidle` on these pages: lessons embed YouTube, which keeps
// connections open long enough that the state may never arrive. Wait for the
// element that proves the page rendered instead.
async function settleOn(page: Page, proof: Locator, timeout = 90_000) {
  await proof.first().waitFor({ state: 'visible', timeout });
}

// The captured session is a static snapshot: Supabase rotates refresh tokens, so
// a storageState that sat unused for hours is often dead. An expired one does not
// error — the app just redirects to /signin, and the take silently becomes a
// recording of the sign-in page. Check before spending the run.
async function assertSignedIn(page: Page) {
  if (/\/signin\b/.test(page.url())) {
    throw new Error(
      'Redirected to /signin — the captured session has expired.\n' +
        'Re-run: npx tsx scripts/demo-auth.ts --url <host>   (then shoot the take straight after)'
    );
  }
}

// The composer disables itself while a turn is in flight; waiting on that is
// what keeps us from typing over the model mid-answer.
async function waitComposerReady(page: Page) {
  const composer = page.locator('form input[placeholder]').first();
  await composer.waitFor({ state: 'visible', timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('form input[placeholder]');
      return el instanceof HTMLInputElement && !el.disabled;
    },
    undefined,
    { timeout: 180_000 }
  );
  return composer;
}

// The section list renders COLLAPSED, and a collapsed section does not render
// its lessons at all — the anchor is absent from the DOM, not merely hidden, so
// clicking it directly waits forever on an element that never arrives. Expand
// sections until the wanted lesson appears. The expansion is worth filming
// anyway: it is what shows the course actually has a structure.
async function openLessonFromSidebar(page: Page, lessonId: string): Promise<Locator> {
  const link = page.locator(`a[href$="${lessonId}"]`).first();
  if (await link.isVisible().catch(() => false)) return link;

  const sections = page.locator('button').filter({ hasText: /^[\u25b8\u25be][\s\S]*\d+\/\d+$/ });
  const count = await sections.count();
  for (let i = 0; i < count; i++) {
    await humanClick(page, sections.nth(i));
    await beat(page, 800);
    if (await link.isVisible().catch(() => false)) return link;
  }
  throw new Error(
    `Lesson ${lessonId} is not in this course's section list — is it a lesson of a different track?`
  );
}

async function runIntakeChat(page: Page) {
  const confirm = page.getByRole('button', { name: /Create program/i });
  const send = page.getByRole('button', { name: /^Send$/ });

  // The goal typed on the landing page arrives PREFILLED in the composer:
  // IntakeChat seeds its input from ?goal= and waits for Send, because
  // auto-sending on mount burned an IntakeSession on every page reload. So the
  // opening turn is a Send with NO typing — typing here appends to the goal and
  // sends the two runs of text concatenated.
  await waitComposerReady(page);
  await beat(page, 1100);
  await humanClick(page, send);
  await beat(page, 900);

  for (const reply of REPLIES) {
    if (await confirm.isVisible().catch(() => false)) return;
    const composer = await waitComposerReady(page);
    if (await confirm.isVisible().catch(() => false)) return;

    await humanClick(page, composer);
    // Clear before typing: a transient send failure calls retryable(), which
    // puts the unsent message BACK in the box, so it is not reliably empty.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(reply, { delay: 42 });
    await beat(page, 400);
    await humanClick(page, send);
    await beat(page, 900);
  }

  await confirm.waitFor({ state: 'visible', timeout: 180_000 });
}

// Cloud Run runs this service at min-instances=0, so the first request after an
// idle period pays a cold start. Spend it before the camera rolls.
async function warmUp(url: string) {
  process.stdout.write('warming the origin… ');
  const started = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${url}/`, { redirect: 'manual' });
      console.log(`${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// HEAD take: landing → goal → intake conversation → the click that starts
// generation. Returns the new program id so the tail take can be pointed at it.
async function recordHead(page: Page, url: string, create: boolean): Promise<string | null> {
  console.log('1/4  landing');
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await assertSignedIn(page);
  await settleOn(page, page.locator('textarea'));
  await beat(page, 2200);

  console.log('2/4  writing the goal');
  await humanClick(page, page.locator('textarea').first());
  await page.keyboard.type(GOAL, { delay: 58 });
  await beat(page, 1400);

  console.log('3/4  intake conversation');
  await humanClick(page, page.getByRole('link', { name: /Build my program/i }));
  await page.waitForURL(/\/programs\/new/, { timeout: 90_000 });
  await beat(page, 1500);
  await runIntakeChat(page);
  await beat(page, 2200);

  if (!create) {
    console.log('4/4  stopping before "Create program" (--no-create: no quota spent)');
    // Settle the cursor on the button without pressing it: the take then fades
    // out on "about to click", which cuts into the tail as cleanly as a real
    // press would, for no quota.
    const btn = page.getByRole('button', { name: /Create program/i });
    await btn.waitFor({ state: 'visible', timeout: 60_000 });
    // Measure only once the transcript has stopped moving. The turn that makes
    // the card appear also appends one more assistant message, which lands
    // AFTER the card and pushes it down the page — a box measured before that
    // reflow leaves the cursor hovering blank paper.
    await waitComposerReady(page);
    await beat(page, 1400);
    await btn.scrollIntoViewIfNeeded();
    await beat(page, 400);
    // Glide toward the measured position for the travel, then let hover() place
    // the pointer authoritatively: it re-runs actionability and waits for the
    // box to be stable across frames, so it corrects for any reflow that landed
    // between measuring and moving.
    const box = await btn.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
    await btn.hover();
    await beat(page, 1700);
    mark('head:cut');
    return null;
  }

  console.log('4/4  starting generation');
  await humanClick(page, page.getByRole('button', { name: /Create program/i }));
  // Hold on the button's "Planning your program…" state — that is the frame the
  // edit cuts on, so the tail take can open on the finished program.
  await beat(page, 2400);
  mark('head:cut');

  await page.waitForURL(/\/programs\/[a-z0-9]+$/i, { timeout: 180_000 });
  const id = new URL(page.url()).pathname.split('/').pop() ?? null;
  console.log(`\n  program created: ${id}`);
  return id;
}

// TAIL take: everything worth showing about a program that is already built.
async function recordTail(page: Page, url: string, programId: string, lessonId?: string) {
  console.log('1/4  program overview');
  await page.goto(`${url}/programs/${programId}`, { waitUntil: 'domcontentloaded' });
  await assertSignedIn(page);
  await settleOn(page, page.getByText(/·\s*READY/i));
  await beat(page, 2600);
  await glideScroll(page, 900);
  await beat(page, 2000);
  await glideScroll(page, -900);
  await beat(page, 800);

  console.log('2/4  into the first course');
  await humanClick(page, page.getByRole('link', { name: /Resume/i }).first());
  await page.waitForURL(/\/programs\/[^/]+\/[^/]+$/, { timeout: 90_000 });
  await settleOn(page, page.getByText(/Key concepts/i));
  await beat(page, 2400);
  await glideScroll(page, 700);
  await beat(page, 1600);
  await glideScroll(page, -700);

  console.log('3/4  a lesson, and the self-check');
  // Prefer the named lesson's own entry in the section list — a real click on a
  // real list item, and it lands somewhere with exercises. Falls back to the
  // continue card when no lesson was named.
  const lessonLink = lessonId
    ? await openLessonFromSidebar(page, lessonId)
    : page.getByRole('link', { name: /Resume/i }).first();
  await humanClick(page, lessonLink);
  await page.waitForURL(/\/programs\/[^/]+\/[^/]+\/[^/]+$/, { timeout: 90_000 });

  // Lesson 1 of a track has no exercises, so this section can legitimately be
  // absent. Degrade to touring the lesson body rather than hanging on a wait
  // that will never resolve.
  const selfCheck = page.getByText(/Check yourself/i).first();
  const hasSelfCheck = await selfCheck
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  await beat(page, 2600);
  await glideScroll(page, 1100);
  await beat(page, 1500);
  if (hasSelfCheck) {
    await humanClick(page, page.getByRole('button', { name: /Reveal answer/i }).first());
    await beat(page, 3200);
  } else {
    console.log('     (no self-check on this lesson — touring the body instead)');
    await glideScroll(page, 700);
    await beat(page, 2200);
  }

  console.log('4/4  progress lands back on the notebook');
  await glideScroll(page, -700);
  await humanClick(page, page.getByRole('button', { name: /Mark viewed/i }).first());
  await beat(page, 1800);
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await settleOn(page, page.getByText(/pick up where you left off/i));
  await beat(page, 3000);
}

function stringArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = appUrl(process.argv);
  const headless = process.argv.includes('--headless');
  const part = stringArg('part');
  const programId = stringArg('program');

  if (part !== 'head' && part !== 'tail') {
    throw new Error(
      'Pass --part head or --part tail.\n' +
        '  head: landing → goal → conversation → Create program (spends 1 program; --no-create to skip the click)\n' +
        '  tail: a tour of an already-built program (free) — also needs --program <id>'
    );
  }
  if (part === 'tail' && !programId) {
    throw new Error('--part tail needs --program <id> (the head take prints the id it created).');
  }
  if (!existsSync(AUTH_STATE)) {
    throw new Error(`No ${AUTH_STATE} — run scripts/demo-auth.ts --url ${url} first.`);
  }

  console.log(`recording ${part} against ${url}`);
  await warmUp(url);

  // Only this part's directory is cleared: re-shooting the tail must not throw
  // away a head take that cost a program to make.
  const partDir = join(OUT_DIR, part);
  rmSync(partDir, { recursive: true, force: true });
  mkdirSync(partDir, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless });
  const context = await browser.newContext({
    storageState: AUTH_STATE,
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    recordVideo: { dir: partDir, size: VIEWPORT },
  });
  await context.addInitScript(CURSOR_SCRIPT);

  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  t0 = Date.now();

  let createdId: string | null = null;
  if (part === 'head') {
    createdId = await recordHead(page, url, !process.argv.includes('--no-create'));
  } else {
    await recordTail(page, url, programId!, stringArg('lesson'));
  }

  mark('end');
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();

  writeFileSync(
    join(partDir, 'marks.json'),
    JSON.stringify({ part, url, programId: createdId ?? programId ?? null, marks, videoPath }, null, 2)
  );
  console.log(`\nRaw video: ${videoPath}`);
  if (part === 'head' && createdId) {
    console.log(`\nOnce the worker has finished writing its courses:`);
    console.log(`  npx tsx scripts/demo-record.ts --part tail --program ${createdId} --url ${url}`);
  } else if (part === 'tail') {
    console.log('\nNext: npx tsx scripts/demo-encode.ts');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
