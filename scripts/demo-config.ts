// Shared knobs for the landing-page demo pipeline (demo-auth → demo-record →
// demo-encode). Kept in one file so the recorder and the encoder cannot drift
// on the output directory or the frame size.

import { resolve } from 'node:path';

// Throwaway Chrome profile used only during sign-in capture.
export const PROFILE_DIR = resolve('.demo-profile');
// The captured session, replayed by the recorder. A live credential: git-ignored,
// written mode 600, never printed and never read back into a conversation.
export const AUTH_STATE = resolve('.demo-auth.json');
export const OUT_DIR = resolve('demo-out');

// 1280x800 at dpr 2: a 16:10 desktop shape that crops well into a landing-page
// hero, captured at retina density so the handwriting fonts stay crisp.
export const VIEWPORT = { width: 1280, height: 800 };
export const DEVICE_SCALE_FACTOR = 2;

// Origin resolution mirrors src/lib/api/public-origin.ts — APP_ORIGIN first,
// localhost last. Deliberately no hardcoded Cloud Run URL: AGENTS.md keeps that
// string in exactly one place (doctoc.ts) so the custom domain lands as one edit.
export function appUrl(argv: string[]): string {
  const i = argv.indexOf('--url');
  const url = (i >= 0 ? argv[i + 1] : undefined) ?? process.env.APP_ORIGIN ?? 'http://localhost:3000';
  return url.replace(/\/$/, '');
}

export function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}
