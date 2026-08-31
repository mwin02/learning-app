// Joins the two takes into the files the landing page ships: an h264 mp4 and a
// vp9 webm. The head take is trimmed to its `head:cut` mark — the frame where
// the learner has just pressed "Create program" — and crossfaded into the tail
// take, which opens on the finished program. That fade is where the worker's
// course-writing time goes.
//
//   npx tsx scripts/demo-encode.ts [--fade 0.5] [--head-speed 1.5 | --head-target 30]
//
// The head take runs long because most of its length is waiting on the model
// between turns. --head-speed compresses it uniformly so every reply is still
// shown, rather than cutting turns out; --head-target picks the speed that
// lands the head on a given number of seconds. The tail always plays at 1x —
// it is a tour, and speeding up a tour reads as a glitch.
//
// Either take encodes on its own if the other is missing, so you can review a
// half before shooting the other.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { OUT_DIR, numArg } from './demo-config';

type Marks = { part: string; marks: { label: string; tMs: number }[]; videoPath?: string };

// Chosen against the real footage: most of the head take is waiting on the
// model between turns, and 1.75x clears that while keeping all four exchanges.
// Override per-run with --head-speed / --head-target.
const HEAD_SPEED = 1.75;

function loadPart(part: 'head' | 'tail'): Marks | null {
  const file = join(OUT_DIR, part, 'marks.json');
  if (!existsSync(file)) return null;
  const data: Marks = JSON.parse(readFileSync(file, 'utf8'));
  if (!data.videoPath || !existsSync(data.videoPath)) {
    throw new Error(`${part}: marks.json points at a missing video (${data.videoPath})`);
  }
  return data;
}

const markAt = (m: Marks, label: string) => m.marks.find((x) => x.label === label)?.tMs;

function encode(inputs: string[], filter: string, out: string, codec: 'mp4' | 'webm') {
  const args = ['-y'];
  for (const i of inputs) args.push('-i', i);
  args.push('-filter_complex', filter, '-map', '[v]');
  args.push(
    ...(codec === 'mp4'
      ? ['-c:v', 'libx264', '-profile:v', 'high', '-crf', '26', '-preset', 'slow',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
      : ['-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1'])
  );
  args.push('-an', out);
  execFileSync(ffmpegPath!, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function main() {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary path');

  const head = loadPart('head');
  const tail = loadPart('tail');
  if (!head && !tail) {
    throw new Error(`Nothing in ${OUT_DIR} — run scripts/demo-record.ts --part head|tail first.`);
  }

  const fade = numArg('fade', 0.5);
  let inputs: string[];
  let filter: string;

  // Resolve the head's playback rate. Never below 1x: slowing the head down is
  // never what is wanted here, and a <1 speed would push the xfade offset past
  // the end of the trimmed segment.
  const headCutMs = head ? (markAt(head, 'head:cut') ?? markAt(head, 'end')) : undefined;
  const headTarget = numArg('head-target', 0);
  const headSpeed = Math.max(
    1,
    headTarget > 0 && headCutMs ? headCutMs / 1000 / headTarget : numArg('head-speed', HEAD_SPEED)
  );

  if (head && tail) {
    // The cut lands on the "Planning your program…" beat; without that mark the
    // head take would run on into the raw program page and spoil the join.
    if (headCutMs === undefined) throw new Error('head/marks.json has no "head:cut" — re-shoot the head take.');
    const cut = headCutMs / 1000;
    const played = cut / headSpeed;
    const offset = Math.max(0, played - fade);
    inputs = [head.videoPath!, tail.videoPath!];
    filter =
      `[0:v]trim=0:${cut.toFixed(3)},setpts=(PTS-STARTPTS)/${headSpeed.toFixed(4)}[h];` +
      `[1:v]setpts=PTS-STARTPTS[t];` +
      `[h][t]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[v]`;
    console.log(
      `joining: head ${cut.toFixed(1)}s → ${played.toFixed(1)}s at ${headSpeed.toFixed(2)}x` +
        `  ✕${fade}s fade✕  tail at 1x`
    );
  } else if (head) {
    const cut = headCutMs! / 1000;
    inputs = [head.videoPath!];
    filter = `[0:v]trim=0:${cut.toFixed(3)},setpts=(PTS-STARTPTS)/${headSpeed.toFixed(4)}[v]`;
    console.log(
      `head take only: ${cut.toFixed(1)}s → ${(cut / headSpeed).toFixed(1)}s at ${headSpeed.toFixed(2)}x`
    );
  } else {
    inputs = [tail!.videoPath!];
    filter = `[0:v]setpts=PTS-STARTPTS[v]`;
    console.log('tail take only (no head recorded yet)');
  }

  const mp4 = join(OUT_DIR, 'demo.mp4');
  const webm = join(OUT_DIR, 'demo.webm');
  console.log('encoding mp4…');
  encode(inputs, filter, mp4, 'mp4');
  console.log('encoding webm…');
  encode(inputs, filter, webm, 'webm');

  for (const f of [mp4, webm]) {
    console.log(`  ${f}  ${execFileSync('du', ['-h', f]).toString().split('\t')[0]}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
